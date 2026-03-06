#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MattermostStack } from '../lib/mattermost-stack';

const app = new cdk.App();

const stackName = app.node.tryGetContext('stackName') || 'Mattermost';
const acmCertificateArn = app.node.tryGetContext('acmCertificateArn') || '';
const customDomain = app.node.tryGetContext('customDomain') || '';
const mattermostImage = app.node.tryGetContext('mattermostImage') || 'mattermost/mattermost-team-edition:latest';

if (!acmCertificateArn) {
  console.warn('WARNING: acmCertificateArn is not set. HTTPS will not work properly.');
}

new MattermostStack(app, stackName, {
  acmCertificateArn,
  customDomain,
  mattermostImage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
