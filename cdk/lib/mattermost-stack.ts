import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Network } from './network';
import { Database } from './database';
import { Storage } from './storage';
import { Service } from './service';

export interface MattermostStackProps extends cdk.StackProps {
  readonly acmCertificateArn: string;
  readonly customDomain: string;
  readonly mattermostImage: string;
}

export class MattermostStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MattermostStackProps) {
    super(scope, id, props);

    const network = new Network(this, 'Network');

    const database = new Database(this, 'Database', {
      networkStack: network,
    });

    const storage = new Storage(this, 'Storage');

    new Service(this, 'Service', {
      vpc: network.vpc,
      networkStack: network,
      database,
      storage,
      acmCertificateArn: props.acmCertificateArn,
      customDomain: props.customDomain,
      mattermostImage: props.mattermostImage,
    });
  }
}
