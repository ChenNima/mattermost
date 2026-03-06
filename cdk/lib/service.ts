import { Construct } from 'constructs';
import {
  Aws,
  CfnCondition,
  CfnOutput,
  Duration,
  Fn,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Network } from './network';
import { Database, DB_NAME } from './database';
import { Storage } from './storage';
import { DatasourceUrl } from './datasource-url';

export interface ServiceProps {
  readonly vpc: ec2.IVpc;
  readonly networkStack: Network;
  readonly database: Database;
  readonly storage: Storage;
  readonly acmCertificateArn: string;
  readonly customDomain: string;
  readonly mattermostImage: string;
  readonly taskCpu?: number;
  readonly taskMemoryMiB?: number;
  readonly desiredCount?: number;
}

export class Service extends Construct {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly endpoint: string;

  constructor(scope: Construct, id: string, props: ServiceProps) {
    super(scope, id);

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.vpc });

    // ALB
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      idleTimeout: Duration.minutes(60),
    });

    // HTTPS Listener
    const listenerCertificate = elbv2.ListenerCertificate.fromArn(props.acmCertificateArn);
    const listener = this.alb.addListener('Listener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [listenerCertificate],
    });

    // HTTP -> HTTPS redirect
    this.alb.addListener('HttpRedirect', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // Custom domain condition
    const hasCustomDomain = new CfnCondition(this, 'HasCustomDomain', {
      expression: Fn.conditionNot(Fn.conditionEquals(props.customDomain, '')),
    });

    // Task execution role
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });
    props.database.dbCredentialSecret.grantRead(taskExecutionRole);

    // Task role (for S3 access via IAM)
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    props.storage.bucket.grantReadWrite(taskRole);

    // Task definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: props.taskCpu ?? 1024,
      memoryLimitMiB: props.taskMemoryMiB ?? 2048,
      executionRole: taskExecutionRole,
      taskRole: taskRole,
    });

    // Determine endpoint URL
    const endpointBase = Fn.conditionIf(
      hasCustomDomain.logicalId,
      props.customDomain,
      this.alb.loadBalancerDnsName,
    ).toString();
    this.endpoint = Fn.join('', ['https://', endpointBase]);

    // Assemble datasource URL via Lambda Custom Resource (image has no shell)
    const datasourceUrl = new DatasourceUrl(this, 'DatasourceUrl', {
      dbCredentialSecret: props.database.dbCredentialSecret,
      dbHost: props.database.dbEndpointAddress,
      dbPort: props.database.dbEndpointPort,
      dbName: DB_NAME,
    });
    datasourceUrl.secret.grantRead(taskExecutionRole);

    // Container
    const container = taskDefinition.addContainer('Mattermost', {
      image: ecs.ContainerImage.fromRegistry(props.mattermostImage),
      memoryLimitMiB: props.taskMemoryMiB ?? 2048,
      environment: {
        MM_SQLSETTINGS_DRIVERNAME: 'postgres',
        MM_FILESETTINGS_DRIVERNAME: 'amazons3',
        MM_FILESETTINGS_AMAZONS3BUCKET: props.storage.bucket.bucketName,
        MM_FILESETTINGS_AMAZONS3REGION: Aws.REGION,
        MM_FILESETTINGS_AMAZONS3IAM: 'true',
        MM_SERVICESETTINGS_SITEURL: this.endpoint,
        MM_SERVICESETTINGS_ENABLELOCALMODE: 'false',
      },
      secrets: {
        MM_SQLSETTINGS_DATASOURCE: ecs.Secret.fromSecretsManager(datasourceUrl.secret),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'mattermost',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    container.addPortMappings({ containerPort: 8065 });

    // Target group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 8065,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/api/v4/system/ping',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
      },
    });

    // Routing rules
    listener.addAction('AlbDnsRule', {
      conditions: [elbv2.ListenerCondition.hostHeaders([this.alb.loadBalancerDnsName])],
      action: elbv2.ListenerAction.forward([targetGroup]),
      priority: 1,
    });

    listener.addAction('DefaultAction', {
      action: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden: Access denied',
      }),
    });

    // Custom domain routing rule (conditional)
    const cfnListenerRule = new elbv2.CfnListenerRule(this, 'CustomDomainRule', {
      actions: [{ type: 'forward', targetGroupArn: targetGroup.targetGroupArn }],
      conditions: [{ field: 'host-header', values: [props.customDomain] }],
      listenerArn: listener.listenerArn,
      priority: 2,
    });
    cfnListenerRule.cfnOptions.condition = hasCustomDomain;

    // Fargate service (public subnet, no NAT Gateway needed)
    const service = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition,
      desiredCount: props.desiredCount ?? 1,
      circuitBreaker: { rollback: true },
      securityGroups: [props.networkStack.serviceSecurityGroup],
      assignPublicIp: true,
      vpcSubnets: props.networkStack.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
    });

    // Allow ALB to reach ECS
    service.connections.allowFrom(this.alb, ec2.Port.tcp(8065), 'Allow ALB to reach Mattermost');

    // Ensure DB is ready and datasource URL secret is written before ECS starts
    service.node.addDependency(props.database.dbCluster);
    service.node.addDependency(datasourceUrl);
    targetGroup.addTarget(service);

    // Outputs
    new CfnOutput(this, 'portalURL', {
      description: 'Mattermost URL',
      value: this.endpoint,
    }).overrideLogicalId('portalURL');

    new CfnOutput(this, 'AlbDnsName', {
      description: 'ALB DNS name (CNAME target for custom domain)',
      value: this.alb.loadBalancerDnsName,
    }).overrideLogicalId('AlbDnsName');

    new CfnOutput(this, 'S3BucketName', {
      description: 'S3 bucket for file storage',
      value: props.storage.bucket.bucketName,
    }).overrideLogicalId('S3BucketName');
  }
}
