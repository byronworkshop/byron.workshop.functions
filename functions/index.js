'use strict';

const functions = require('firebase-functions');

const {Storage} = require('@google-cloud/storage');
const gcs = new Storage({keyFilename: 'service-account-credentials.json'});
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
db.settings({ timestampsInSnapshots: true });

const path = require('path');
const sharp = require('sharp');

const promiseRetry = require('promise-retry');

// thumbnail dimensions in pixels
const THUMB_MAX_HEIGHT = 250;
const THUMB_MAX_WIDTH = 250;

// thumbnail file prefix
const THUMB_PREFIX = 'thumb_';

// batch size to perform cascade deletion
const BATCH_SIZE = 20;


// -----------------------------------------------------
// functions
// -----------------------------------------------------
function deleteFolder(folderPath, bucketName) {
    console.log('deleting folder.', folderPath);

    const folderBucket = gcs.bucket(bucketName);
    return folderBucket.deleteFiles({prefix: folderPath, force: true});
}

function deleteDocument(documentRef) {
    console.log('deleting document.', documentRef.path);
    return documentRef.delete();
}

function deleteCollection(db, collectionRef, batchSize) {
    const query = collectionRef.limit(batchSize);
    const collectionPath = collectionRef.path;
    console.log('deleting collection.', collectionPath);

    return new Promise((resolve, reject) => {
        deleteQueryBatch(db, query, batchSize, collectionPath, resolve, reject)
    });
}

function deleteQueryBatch(db, query, batchSize, collectionPath, resolve, reject) {
    query.get()
        .then((snapshot) => {
            // when there are no documents left, we are done
            if (snapshot.size === 0) {
                return 0;
            }

            // delete documents in a batch
            const batch = db.batch();
            snapshot.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });

            // eslint-disable-next-line
            return batch.commit().then(() => {
                return snapshot.size;
            });
        })
        .then((numDeleted) => {
            // eslint-disable-next-line
            if (numDeleted === 0) {
                console.log('all documents deleted.', collectionPath);
                resolve();
                return;
            }

            // recurse on the next process tick, to avoid
            // exploding the stack.
            process.nextTick(() => {
                deleteQueryBatch(db, query, batchSize, collectionPath, resolve, reject);
            });
        })
        .catch(reject);
}


// -----------------------------------------------------
// triggers
// -----------------------------------------------------

// thumbnails
// -------
exports.generateThumbnail = functions.storage.object().onFinalize((object) => {
    const fileBucket = object.bucket; // the storage bucket that contains the file.
    const filePath = object.name; // file path in the bucket.
    const contentType = object.contentType; // file content type.

    // exit if this is triggered on a file that is not an image.
    if (!contentType.startsWith('image/')) {
        console.log('this is not an image.');
        return null;
    }

    // get the file name.
    const fileName = path.basename(filePath);
    const fileDir = path.dirname(filePath);

    // exit if the image is already a thumbnail.
    if (fileName.startsWith(THUMB_PREFIX)) {
        console.log('already a thumbnail.');
        return null;
    }

    // download file from bucket.
    const bucket = gcs.bucket(fileBucket);
    const metadata = {
        contentType: contentType,
    };

    // we add a 'thumb_' prefix to thumbnails file name
    const thumbFileName = `${THUMB_PREFIX}${fileName}`;
    const thumbFilePath = path.join(fileDir, thumbFileName);

    // create write stream for uploading thumbnail
    const thumbnailUploadStream = bucket.file(thumbFilePath).createWriteStream({metadata});

    // create Sharp pipeline for resizing the image and use pipe to read from bucket read stream
    const pipeline = sharp();
    pipeline
        .resize(THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT, {fit: "inside"})
        .pipe(thumbnailUploadStream);

    const bucketFilePath = bucket.file(filePath);
    const bucketThumbFilePath = bucket.file(thumbFilePath);

    bucketFilePath.createReadStream().pipe(pipeline);

    const streamAsPromise = new Promise((resolve, reject) =>
        thumbnailUploadStream.on('finish', resolve).on('error', reject));

    return streamAsPromise.then(() => {
        console.log('thumbnail created successfully.');

        // get the Signed URLs for the thumbnail and original image.
        const config = {
            action: 'read',
            expires: '01-01-2025', // 2025
        };

        return Promise.all([
            bucketFilePath.getSignedUrl(config),
            bucketThumbFilePath.getSignedUrl(config)
        ]);
    }).then((results) => {
        console.log('got signed URLs.');

        const fileResult = results[0];
        const thumbResult = results[1];
        const thumbnailPublicUrl = thumbResult[0];
        const filePublicUrl = fileResult[0];

        const photoUpdates = {
            'image.imageUrl': filePath,
            'image.imagePublicUrl': filePublicUrl,
            'image.thumbnailUrl': thumbFilePath,
            'image.thumbnailPublicUrl': thumbnailPublicUrl,
            'image.bucket': fileBucket
        };

        // retry 5 times until document is found
        return promiseRetry({retries: 5}, (retry, number) => {
            console.log('attempt update firestore', number);

            // eslint-disable-next-line
            return admin.firestore().doc(fileDir).update(photoUpdates)
                .catch(retry);
        });
    }).then(() => {
        return console.log('thumbnail URLs saved to database.')
    }).catch((error) => {
        console.log('ERROR, deleting uploaded images', error.message);
        return Promise.all([
            bucketFilePath.delete(),
            bucketThumbFilePath.delete()
        ]);
    });
});


// deletes
// -------
exports.deleteMotorcycle = functions.firestore.document('users/{uid}/motorcycles/{motorcycleId}')
    .onDelete((snap, context) => {
        const uid = context.params.uid;
        const motorcycleId = context.params.motorcycleId;
        const workOrderFormsColl = db.collection('users').doc(uid).collection('work_orders').doc(motorcycleId).collection('forms');

        const motorcycle = snap.data();
        const image = motorcycle.image;
        const bucketName = image.bucket;
        const folderPath = snap.ref.path;

        console.log('deleting motorcycle.', snap.ref.path);

        return Promise.all(
            [
                deleteFolder(folderPath, bucketName),
                deleteCollection(db, workOrderFormsColl, BATCH_SIZE)
            ]
        );
    });

exports.deleteWorkOrder = functions.firestore.document('users/{uid}/work_orders/{motorcycleId}/forms/{woId}')
    .onDelete((snap, context) => {
        const uid = context.params.uid;
        const woId = context.params.woId;
        const motorcycleId = context.params.motorcycleId;
        const userRef = db.collection('users').doc(uid);
        const motorcycleWorkOrdersRef = userRef.collection('work_orders').doc(motorcycleId);

        console.log('deleting work order.', snap.ref.path);

        return Promise.all(
            [
                deleteDocument(userRef.collection('work_orders$metadata').doc(woId)),
                deleteCollection(db, motorcycleWorkOrdersRef.collection('file_repos').doc(woId).collection('images'), BATCH_SIZE),
                deleteCollection(db, motorcycleWorkOrdersRef.collection('cost_sheets').doc(woId).collection('costs'), BATCH_SIZE)
            ]);
    });

exports.deleteWorkOrderImageFiles = functions.firestore.document('users/{uid}/work_orders/{woId}/file_repos/{woFormId}/images/{imageId}')
    .onDelete((snap) => {
        const uploadedImage = snap.data();

        if (!uploadedImage || !uploadedImage.image) {
            console.log('empty image.');
            return null;
        }

        const imageUrl = uploadedImage.image.imageUrl;
        const thumbnailUrl = uploadedImage.image.thumbnailUrl;
        const imagesBucket = uploadedImage.image.bucket;

        console.log('deleting images.', snap.ref.path);
        const bucket = gcs.bucket(imagesBucket);

        return Promise.all([
            bucket.file(imageUrl).delete(),
            bucket.file(thumbnailUrl).delete()
        ]);
    });