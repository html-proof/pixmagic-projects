import { Duration } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * A 1 GB swap file, kept across reboots. dnf needs more than a t4g.nano's 512 MB: without it the
 * kernel kills `dnf install` (seen 2026-10-17 on Amazon Linux 2023).
 */
export const SWAP_FILE_COMMANDS = [
  "dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none",
  "chmod 600 /swapfile",
  "mkswap /swapfile",
  "swapon /swapfile",
  'echo "/swapfile none swap defaults 0 0" >> /etc/fstab',
];

/**
 * The VPC's way out to the internet: a small EC2 instance doing NAT in each public subnet, instead
 * of NAT gateways (US$0.059/hour each in Sydney, ~US$47/month with the address; one of these is
 * ~US$8). Each Availability Zone's private subnets go out through the instance in the same AZ, so
 * an outage of one AZ leaves the other's way out alone (Trusted Advisor: "NAT Gateway AZ
 * Independence", "Single AZ Application Check").
 *
 * - Amazon Linux 2023 (arm64), iptables MASQUERADE for the VPC's addresses; no SSH key, reached
 *   only through Systems Manager; inbound only from inside the VPC.
 * - CloudFormation waits for the instance to report NAT ready (cfn-signal) before it moves a
 *   subnet's route to it. A new Amazon Linux image or new user data replaces the instance that way
 *   (the new one is up before the old one goes), so a deploy also patches it.
 * - Recovery: data-stack.ts's alarms recover it on the host's failure and reboot it on its own;
 *   the instance id, private and public addresses survive both, so the routes stay valid.
 */
export class NatInstancePerAz extends ec2.NatProvider {
  private readonly byAz = new Map<string, ec2.Instance>();

  constructor(private readonly props: { instanceType: ec2.InstanceType; namePrefix: string }) {
    super();
  }

  /** The NAT instances, one per public subnet given the provider (natGateways of them). */
  get instances(): ec2.Instance[] {
    return [...this.byAz.values()];
  }

  get configuredGateways(): ec2.GatewayConfig[] {
    return [...this.byAz].map(([az, instance]) => ({ az, gatewayId: instance.instanceId }));
  }

  configureNat(options: ec2.ConfigureNatOptions): void {
    const { vpc } = options;
    const sg = new ec2.SecurityGroup(vpc, "NatSecurityGroup", {
      vpc,
      securityGroupName: `${this.props.namePrefix}-nat`,
      description: "Insights NAT instances: forward outbound traffic from the VPC",
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTraffic(), "Traffic from inside the VPC on its way out");
    const role = new iam.Role(vpc, "NatRole", {
      roleName: `${this.props.namePrefix}-nat`,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });

    for (const subnet of options.natSubnets) {
      const userData = ec2.UserData.forLinux();
      const instance = new ec2.Instance(subnet, "NatInstance", {
        instanceName: `${this.props.namePrefix}-nat-${subnet.availabilityZone.slice(-1)}`,
        vpc,
        vpcSubnets: { subnets: [subnet] },
        securityGroup: sg,
        role,
        instanceType: this.props.instanceType,
        machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
        sourceDestCheck: false,
        // IMDSv2 on the instance itself: requireImdsv2 adds a launch template named after the
        // construct id ("NatInstanceLaunchTemplate"), the same for both, and EC2 refuses the second.
        httpTokens: ec2.HttpTokens.REQUIRED,
        blockDevices: [{ deviceName: "/dev/xvda", volume: ec2.BlockDeviceVolume.ebs(8, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3 }) }],
        userData,
        // A changed script runs only on a new instance (cloud-init runs user data once), and a
        // new one comes up before the routes move: replace, never stop/start in place.
        userDataCausesReplacement: true,
        resourceSignalTimeout: Duration.minutes(15),
      });
      userData.addCommands(
        "set -euo pipefail",
        ...SWAP_FILE_COMMANDS,
        // The image has no iptables or nft (cfn-signal it has).
        "dnf install -y --setopt=install_weak_deps=False iptables-services",
        'echo "net.ipv4.ip_forward = 1" > /etc/sysctl.d/90-nat.conf',
        "sysctl -p /etc/sysctl.d/90-nat.conf",
        // The stock rules end the FORWARD chain in REJECT: start the service, then replace them.
        "systemctl enable --now iptables",
        "out=$(ip -4 route show default | awk '{print $5; exit}')",
        `iptables -t nat -A POSTROUTING -s ${vpc.vpcCidrBlock} -o "$out" -j MASQUERADE`,
        "iptables -F FORWARD",
        "iptables-save > /etc/sysconfig/iptables",
        "systemctl disable --now sshd || true",
      );
      // Reports success (or the failing exit code) when the script ends; CloudFormation waits for it.
      userData.addSignalOnExitCommand(instance);
      this.byAz.set(subnet.availabilityZone, instance);
    }
    for (const subnet of options.privateSubnets) this.configureSubnet(subnet);
  }

  configureSubnet(subnet: ec2.PrivateSubnet): void {
    // Same AZ when there is one there (natGateways >= AZs); otherwise the first.
    const instance = this.byAz.get(subnet.availabilityZone) ?? this.instances[0];
    if (!instance) throw new Error("NatInstancePerAz: no public subnet to put a NAT instance in");
    subnet.addRoute("DefaultRoute", { routerType: ec2.RouterType.INSTANCE, routerId: instance.instanceId, enablesInternetConnectivity: true });
  }
}
