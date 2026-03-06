import { Construct } from 'constructs';
import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';

export interface DatasourceUrlProps {
  readonly dbCredentialSecret: secretsmanager.ISecret;
  readonly dbHost: string;
  readonly dbPort: string;
  readonly dbName: string;
}

/**
 * Custom Resource that reads DB credentials from Secrets Manager
 * and assembles a full PostgreSQL datasource URL stored in a new secret.
 * This avoids needing a shell in the container image.
 */
export class DatasourceUrl extends Construct {
  readonly secret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DatasourceUrlProps) {
    super(scope, id);

    // Secret to hold the assembled datasource URL
    const datasourceSecret = new secretsmanager.Secret(this, 'Secret', {
      description: 'Mattermost MM_SQLSETTINGS_DATASOURCE',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      logRetention: logs.RetentionDays.THREE_DAYS,
      code: lambda.Code.fromInline(`
import json
import boto3
import cfnresponse

def handler(event, context):
    try:
        if event['RequestType'] == 'Delete':
            cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
            return

        sm = boto3.client('secretsmanager')

        cred_arn = event['ResourceProperties']['CredentialSecretArn']
        target_arn = event['ResourceProperties']['TargetSecretArn']
        db_host = event['ResourceProperties']['DbHost']
        db_port = event['ResourceProperties']['DbPort']
        db_name = event['ResourceProperties']['DbName']

        cred = json.loads(sm.get_secret_value(SecretId=cred_arn)['SecretString'])
        username = cred['username']
        password = cred['password']

        datasource = f"postgres://{username}:{password}@{db_host}:{db_port}/{db_name}?sslmode=require&connect_timeout=10"

        sm.put_secret_value(SecretId=target_arn, SecretString=datasource)

        cfnresponse.send(event, context, cfnresponse.SUCCESS, {'SecretArn': target_arn})
    except Exception as e:
        print(e)
        cfnresponse.send(event, context, cfnresponse.FAILED, {'Error': str(e)})
`),
    });

    props.dbCredentialSecret.grantRead(fn);
    datasourceSecret.grantWrite(fn);

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: fn,
    });

    new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        CredentialSecretArn: props.dbCredentialSecret.secretArn,
        TargetSecretArn: datasourceSecret.secretArn,
        DbHost: props.dbHost,
        DbPort: props.dbPort,
        DbName: props.dbName,
      },
    });

    this.secret = datasourceSecret;
  }
}
