'use strict';

import AWS from 'aws-sdk';
import { debug } from './index';
import csv from 'fast-csv';
import { Recipient } from 'moonmail-models';
import base64url from 'base64-url';
import querystring from 'querystring';
import moment from 'moment';

class ImportRecipientsService {

  constructor({s3Event, importOffset = 0 }, s3Client, lambdaClient, context) {
    this.s3Event = s3Event;
    this.importOffset = importOffset;
    this.bucket = s3Event.bucket.name;
    this.fileKey = querystring.unescape(s3Event.object.key);
    const file = this.fileKey.split('.');
    this.userId = file[0];
    this.listId = file[1];
    this.fileExt = file[file.length - 1];
    this.s3 = s3Client;
    this.corruptedEmails = [];
    this.recipients = [];
    this.totalRecipientsCount = 0;
    this.lambdaClient = lambdaClient;
    this.lambdaName = context.functionName;
    this.context = context;
    this.headerMapping = null;
  }

  get executionThreshold() {
    return 60000;
  }

  get maxBatchSize() {
    return 25;
  }

  // @deprecated
  get s3Client() {
    debug('= ImportRecipientsService.s3Client', 'Getting S3 client');
    if (!this.s3) {
      this.s3 = new AWS.S3({ region: process.env.SERVERLESS_REGION || 'us-east-1' });
    }
    return this.s3;
  }

  timeEnough() {
    return (this.context.getRemainingTimeInMillis() > this.executionThreshold);
  }

  importAll() {
    return this.parseFile().then(recipients => {
      this.totalRecipientsCount = recipients.length || 0;
      this.recipients = recipients.filter(this.filterByEmail.bind(this));
      return this.saveRecipients();
    });
  }

  saveRecipients() {
    if (this.importOffset < this.recipients.length) {
      const recipientsBatch = this.recipients.slice(this.importOffset, this.importOffset + this.maxBatchSize);
      return Recipient.saveAll(recipientsBatch)
        .then(data => {
          if (this.timeEnough()) {
            if (data.UnprocessedItems && data.UnprocessedItems instanceof Array) {
              this.importOffset += (this.maxBatchSize - data.UnprocessedItems.length);
            } else {
              this.importOffset += Math.min(this.maxBatchSize, recipientsBatch.length);
            }
            return this.saveRecipients();
          } else {
            if (data.UnprocessedItems && data.UnprocessedItems instanceof Array) {
              this.importOffset += (this.maxBatchSize - data.UnprocessedItems.length);
            } else {
              this.importOffset += Math.min(this.maxBatchSize, recipientsBatch.length);
            }
            debug('= ImportRecipientsService.saveRecipients', 'Not enough time left. Invoking lambda');
            return this.invokeLambda();
          }
        }).catch(err => {
          debug('= ImportRecipientsService.saveRecipients', 'Error while saving recipients', err, err.stack);
          const importStatus = {
            listId: this.listId,
            userId: this.userId,
            totalRecipientsCount: this.totalRecipientsCount,
            corruptedEmailsCount: this.corruptedEmails.length,
            corruptedEmails: this.corruptedEmails,
            importedCount: this.importOffset,
            importStatus: 'FAILED',
            updatedAt: new Date().toString(),
            message: err.message,
            stackTrace: err.stack
          };
          Promise.reject(importStatus);
        });
    } else {
      const importStatus = {
        listId: this.listId,
        userId: this.userId,
        totalRecipientsCount: this.totalRecipientsCount,
        importedCount: this.importOffset,
        corruptedEmailsCount: this.corruptedEmails.length,
        corruptedEmails: this.corruptedEmails,
        importStatus: 'SUCCESS',
        updatedAt: new Date().toString()
      };
      debug('= ImportRecipientsService.saveRecipients', 'Saved recipients successfully', importStatus);
      Promise.resolve(importStatus);
    }
  }

  invokeLambda() {
    return new Promise((resolve, reject) => {
      debug('= ImportRecipientsService.invokeLambda', 'Invoking function again', this.lambdaName);
      const payload = { Records: [{ s3: this.s3Event }], importOffset: this.importOffset };
      const params = {
        FunctionName: this.lambdaName,
        InvocationType: 'Event',
        Payload: JSON.stringify(payload)
      };
      this.lambdaClient.invoke(params, (err, data) => {
        if (err) {
          debug('= ImportRecipientsService.invokeLambda', 'Error invoking lambda', err, err.stack);
          reject(err);
        } else {
          debug('= ImportRecipientsService.invokeLambda', 'Invoked successfully');
          resolve(data);
        }
      });
    });
  }

  parseFile() {
    return new Promise((resolve, reject) => {
      const params = { Bucket: this.bucket, Key: this.fileKey };
      debug('= ImportRecipientsService.parseFile', 'File', this.fileKey);
      this.s3Client.getObject(params, (err, data) => {
        if (err) {
          debug('= ImportRecipientsService.parseFile', 'Error while loading an S3 file', err, err.stack);
          reject(err);
        } else {
          if (this.fileExt === 'csv') {
            this.headerMapping = JSON.parse(data.Metadata);
            this.parseCSV(data.Body.toString('utf8'), (recipients) => {
              resolve(recipients);
            });
          } else {
            debug('= ImportRecipientsService.parseFile', `${this.fileExt} is not supported`);
            reject(`${this.fileExt} is not supported`);
          }
        }
      });
    });
  }

  parseCSV(csvString, callback) {
    let recipients = [];
    const headerMapping = this.headerMapping;
    const userId = this.userId;
    const listId = this.listId;

    csv.fromString(csvString, { headers: true, ignoreEmpty: true, objectMode: true })
      .on('data', function (data) {
        let newRecp = {
          id: base64url.encode(data.email),
          userId: userId,
          listId: listId,
          email: data.email,
          metadata: {},
          status: Recipient.statuses.subscribed,
          isConfirmed: true,
          createdAt: new Date().getTime()
        };
        for (let key in headerMapping) {
          const newKey = headerMapping[key];
          newRecp.metadata[newKey] = data[key];
        };
        recipients.push(newRecp);
      })
      .on('end', function () {
        callback(recipients);
      });
  }

  filterByEmail(recipient) {
    const email = recipient.email;
    if (/\S+@\S+\.\S+/.test(email)) {
      return true;
    } else {
      this.corruptedEmails.push(email);
      return false;
    }
  }
}

module.exports.ImportRecipientsService = ImportRecipientsService;
