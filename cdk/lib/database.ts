import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Network } from './network';

export const DB_NAME = 'mattermost';
const DB_USERNAME = 'mmuser';

export interface DatabaseProps {
  readonly networkStack: Network;
}

export class Database extends Construct {
  readonly dbCredentialSecret: secretsmanager.Secret;
  readonly dbEndpointAddress: string;
  readonly dbEndpointPort: string;
  readonly dbCluster: rds.DatabaseCluster;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);

    // Let Secrets Manager generate and manage the password (stable across deploys)
    this.dbCredentialSecret = new secretsmanager.Secret(this, 'DBCredential', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: DB_USERNAME }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.dbCluster = new rds.DatabaseCluster(this, 'Cluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_17_6,
      }),
      vpc: props.networkStack.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      credentials: rds.Credentials.fromSecret(this.dbCredentialSecret),
      defaultDatabaseName: DB_NAME,
      securityGroups: [props.networkStack.dbSecurityGroup],
      storageEncrypted: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      backup: {
        retention: Duration.days(1),
        preferredWindow: '19:00-20:00',
      },
    });

    this.dbEndpointAddress = this.dbCluster.clusterEndpoint.hostname;
    this.dbEndpointPort = this.dbCluster.clusterEndpoint.port.toString();
  }
}
