'use strict';

const functions = require('firebase-functions');

const gcs = require('@google-cloud/storage')({keyFilename: 'service-account-credentials.json'});
const admin = require('firebase-admin');
admin.initializeApp();

const path = require('path');
const sharp = require('sharp');

// thumbnail dimensions in pixels
const THUMB_MAX_HEIGHT = 200;
const THUMB_MAX_WIDTH = 200;

// thumbnail file prefix
const THUMB_PREFIX = 'thumb_';

// -----------------------
// functions
// -----------------------
function createThumbnail(fileBucket, filePath, thumbFilePath, contentType) {
    // Exit if this is triggered on a file that is not an image.
    if (!contentType.startsWith('image/')) {
        console.log('this is not an image');
        return null;
    }

    // Get the file name.
    const fileName = path.basename(filePath);
    // Exit if the image is already a thumbnail.
    if (fileName.startsWith(THUMB_PREFIX)) {
        console.log('already a thumbnail');
        return null;
    }

    // Download file from bucket.
    const bucket = gcs.bucket(fileBucket);
    const metadata = {
        contentType: contentType,
    };

    // Create write stream for uploading thumbnail
    const thumbnailUploadStream = bucket.file(thumbFilePath).createWriteStream({metadata});

    // Create Sharp pipeline for resizing the image and use pipe to read from bucket read stream
    const pipeline = sharp();
    pipeline
        .resize(THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT)
        .max()
        .pipe(thumbnailUploadStream);

    bucket.file(filePath).createReadStream().pipe(pipeline);

    const streamAsPromise = new Promise((resolve, reject) =>
        thumbnailUploadStream.on('finish', resolve).on('error', reject));

    return streamAsPromise.then(() => {
        console.log('thumbnail created successfully');

        // get the Signed URLs for the thumbnail and original image
        const thumbFile = bucket.file(thumbFilePath);
        const config = {
            action: 'read',
            expires: '03-01-2500',
        };

        return thumbFile.getSignedUrl(config);
    });
}

// function createThumbnail2(filePath, thumbFilePath, fileBucket, contentType) {
//     // tmp files
//     const tempLocalFile = path.join(os.tmpdir(), filePath);
//     const tempLocalDir = path.dirname(tempLocalFile);
//     const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);
//
//     // cloud storage vars
//     console.log('bucket creation');
//     const bucket = gcs.bucket(fileBucket);
//     console.log('bucket created');
//     const file = bucket.file(filePath);
//     const thumbFile = bucket.file(thumbFilePath);
//     const metadata = {
//         contentType: contentType
//     };
//
//     return mkdirp(tempLocalDir).then(() => {
//         // download file from bucket
//         return file.download({destination: tempLocalFile});
//     }).then(() => {
//         console.log('file downloaded to', tempLocalFile);
//
//         // generate a thumbnail using ImageMagick
//         return spawn('convert', [tempLocalFile, '-thumbnail', `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}>`, tempLocalThumbFile], {capture: ['stdout', 'stderr']});
//     }).then(() => {
//         console.log('thumbnail created at', tempLocalThumbFile);
//
//         // uploading thumbnail
//         return bucket.upload(tempLocalThumbFile, {destination: thumbFilePath, metadata: metadata});
//     }).then(() => {
//         console.log('thumbnail uploaded to Storage at', thumbFilePath);
//
//         // once the image has been uploaded delete the local files to free up disk space
//         fs.unlinkSync(tempLocalFile);
//         fs.unlinkSync(tempLocalThumbFile);
//
//         // get the Signed URLs for the thumbnail and original image
//         const config = {
//             action: 'read',
//             expires: '03-01-2500',
//         };
//         return thumbFile.getSignedUrl(config);
//     });
// }

function deleteOldMotorcyclePhotos(oldMotorcycleDocument) {
    console.log('deleting old motorcycle photos', oldMotorcycleDocument);

    const photoObject = oldMotorcycleDocument.photo;
    console.log('grabbing old photo data', photoObject);

    // return if photo does not exists
    if (!photoObject) {
        console.log('old document does not contains a photo object');
        return null;
    }

    const photosBucket = photoObject.bucket;
    const photoUrl = photoObject.photoUrl;
    const thumbnailUrl = photoObject.thumbnailUrl;

    if (photoUrl && !thumbnailUrl) {
        console.log('cannot delete, this is a recent photo creation');
        return null;
    }

    console.log('deleting old photos from bucket');
    const bucket = gcs.bucket(photosBucket);

    return Promise.all([
        bucket.file(photoUrl).delete(),
        bucket.file(thumbnailUrl).delete()
    ]);
}

// -----------------------
// triggers
// -----------------------
exports.createMotorcycleThumbnailOnCreation = functions.firestore.document('users/{uui}/motorcycles/{motorcycleId}')
    .onCreate((snap, context) => {
        console.log('triggered motorcycle create');

        // grab motorcycle document
        const motorcycleDocument = snap.data();
        console.log('grabbing data', motorcycleDocument);

        const photoObject = motorcycleDocument.photo;
        console.log('grabbing photo data', photoObject);

        // return if photo does not exists
        if (!photoObject) {
            console.log('document does not contains a photo object');
            return null;
        }

        // return if thumbnail has already been set
        if (photoObject.thumbnailPublicUrl) {
            console.log('already processed');
            return null;
        }

        const filePath = photoObject.photoUrl;
        const fileBucket = photoObject.bucket;
        const fileContentType = photoObject.contentType;
        const filePhotoPublicUrl = photoObject.photoPublicUrl;

        // file and directory paths
        const contentType = fileContentType; // this is the image MIME type
        const fileDir = path.dirname(filePath);
        const fileName = path.basename(filePath);
        const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));

        return createThumbnail(fileBucket, filePath, thumbFilePath, contentType)
            .then((thumbFileUrl) => {
                console.log('got signed thumbnail URL');

                // add the URLs to the database
                motorcycleDocument.photo = {
                    photoUrl: filePath,
                    thumbnailUrl: thumbFilePath,
                    photoPublicUrl: filePhotoPublicUrl,
                    thumbnailPublicUrl: thumbFileUrl[0],
                    bucket: fileBucket,
                    contentType: fileContentType
                };

                return snap.ref.set(motorcycleDocument);
            }).then(() => console.log('thumbnail URLs saved to database'));
    });

exports.createMotorcycleThumbnailOnUpdate = functions.firestore.document('users/{uui}/motorcycles/{motorcycleId}')
    .onUpdate((change, context) => {
        console.log('triggered motorcycle update');

        // grab motorcycle documents
        const motorcycleDocument = change.after.data();
        const oldMotorcycleDocument = change.before.data();

        console.log('grabbing old data', oldMotorcycleDocument);
        console.log('grabbing new data', motorcycleDocument);

        const photoObject = motorcycleDocument.photo;
        console.log('grabbing photo data', photoObject);

        // return if photo does not exists
        if (!photoObject) {
            console.log('document does not contains a photo object');
            return null;
        }

        // return if thumbnail has already been set
        if (photoObject.thumbnailPublicUrl) {
            console.log('already processed');
            return null;
        }

        const filePath = photoObject.photoUrl;
        const fileBucket = photoObject.bucket;
        const fileContentType = photoObject.contentType;
        const filePhotoPublicUrl = photoObject.photoPublicUrl;

        // file and directory paths
        const contentType = fileContentType; // this is the image MIME type
        const fileDir = path.dirname(filePath);
        const fileName = path.basename(filePath);
        const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));

        return createThumbnail(fileBucket, filePath, thumbFilePath, contentType)
            .then((thumbFileUrl) => {
                console.log('got signed thumbnail URL');

                // add the URLs to the database
                motorcycleDocument.photo = {
                    photoUrl: filePath,
                    thumbnailUrl: thumbFilePath,
                    photoPublicUrl: filePhotoPublicUrl,
                    thumbnailPublicUrl: thumbFileUrl[0],
                    bucket: fileBucket,
                    contentType: fileContentType
                };

                return change.after.ref.set(motorcycleDocument);
            }).then(() => {
                console.log('thumbnail URLs saved to database');
                return deleteOldMotorcyclePhotos(oldMotorcycleDocument);
            });
    });

exports.createWorkOrderImageThumbnail = functions.firestore.document('users/{uui}/work_orders/{woId}/file_repos/{woFormId}/images/{imageId}')
    .onCreate((snap, context) => {
        console.log('triggered image creation');

        // grab image document
        const imageDocument = snap.data();
        console.log('grabbing image data', imageDocument);

        // return if photo does not exists
        if (!imageDocument) {
            console.log('document does not contains an image');
            return null;
        }

        // return if thumbnail has already been set
        if (imageDocument.thumbnailPublicUrl) {
            console.log('already processed');
            return null;
        }

        const fileDate = imageDocument.date;
        const filePath = imageDocument.imageUrl;
        const fileBucket = imageDocument.bucket;
        const fileContentType = imageDocument.contentType;
        const filePhotoPublicUrl = imageDocument.imagePublicUrl;

        // File and directory paths.
        const contentType = fileContentType; // This is the image MIME type
        const fileDir = path.dirname(filePath);
        const fileName = path.basename(filePath);
        const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));

        return createThumbnail(fileBucket, filePath, thumbFilePath, contentType)
            .then((thumbFileUrl) => {
                console.log('got signed thumbnail URL');

                // Add the URLs to the Database
                const imageDocument = {
                    imageUrl: filePath,
                    thumbnailUrl: thumbFilePath,
                    imagePublicUrl: filePhotoPublicUrl,
                    thumbnailPublicUrl: thumbFileUrl[0],
                    bucket: fileBucket,
                    contentType: fileContentType,
                    date: fileDate
                };

                return snap.ref.set(imageDocument);
            }).then(() => console.log('thumbnail URLs saved to database'));
    });

exports.deleteWorkOrderImageFiles = functions.firestore.document('users/{uui}/work_orders/{woId}/file_repos/{woFormId}/images/{imageId}')
    .onDelete((snap, context) => {
        const deletedImage = snap.data();

        const imageUrl = deletedImage.imageUrl;
        const thumbnailUrl = deletedImage.thumbnailUrl;
        const imagesBucket = deletedImage.bucket;

        console.log('deleting images from bucket');
        const bucket = gcs.bucket(imagesBucket);

        return Promise.all([
            bucket.file(imageUrl).delete(),
            bucket.file(thumbnailUrl).delete()
        ]);
    });
	