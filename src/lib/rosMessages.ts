/**
 * ROS 2 sensor-message builders for the robotics-mode export. Produces
 * JSON payloads shaped exactly like canonical `sensor_msgs/Imu`,
 * `sensor_msgs/LaserScan`, and `nav_msgs/Odometry` so the synthetic
 * data drops straight into a ROS 2 pipeline (`ros2 bag` / rclpy /
 * rclcpp callbacks) without re-mapping field names.
 *
 * We export as JSON-Lines (one message per line) instead of a real
 * `.bag` because rosbag is a binary format that requires a CDR
 * serializer the browser doesn't have. JSONL replays trivially:
 *
 *     ros2 run rosbag2_play_jsonl rosbag.jsonl
 *
 * (or any user's own loader — the message shapes match `ros2 msg show`
 * exactly so a deserializer is a one-liner).
 *
 * Frame conventions follow the REP-105 standard:
 *   - `base_link`   the rover chassis frame
 *   - `imu_link`    chassis IMU mount, identity-rotated from base_link
 *   - `laser_link`  ToF/lidar mount, on the rover head
 *   - `odom`        world-fixed odometry frame (= our scene origin)
 *
 * Time is reported in ROS 2's `builtin_interfaces/Time` form
 * (`{ sec, nanosec }`) using `performance.now()` as the wall clock.
 * That keeps timestamps monotonic across the capture window even when
 * the user's system clock drifts.
 */

import type { AccelSample, LidarSample } from '../store/useStore';

/** Ground-plane rover pose: position on the ground (y = 0) plus a yaw
 * heading. Mirrors the inline shape used in the store; lifted here
 * because ROS-message builders need a named type for clarity. */
export type RoverPose = { x: number; z: number; heading: number };

export type RosTime = { sec: number; nanosec: number };

export function performanceNowToRosTime(ms: number): RosTime {
  const sec = Math.floor(ms / 1000);
  const nanosec = Math.round((ms - sec * 1000) * 1_000_000);
  return { sec, nanosec };
}

export type RosHeader = {
  stamp: RosTime;
  frame_id: string;
};

/** sensor_msgs/Imu — identity orientation + zero covariances since
 * we don't synthesize an EKF; downstream nodes that want orientation
 * can fuse `linear_acceleration` + `angular_velocity` themselves
 * (madgwick, ekf_localization, etc.). */
export type RosImuMessage = {
  header: RosHeader;
  orientation: { x: number; y: number; z: number; w: number };
  orientation_covariance: number[];
  angular_velocity: { x: number; y: number; z: number };
  angular_velocity_covariance: number[];
  linear_acceleration: { x: number; y: number; z: number };
  linear_acceleration_covariance: number[];
};

export function buildImuMessage(
  sample: AccelSample,
  frameId = 'imu_link',
): RosImuMessage {
  // -1 in the [0] slot of a covariance signals "unknown" per
  // sensor_msgs/Imu spec; downstream nodes treat it as opt-out. We
  // fill the rest with zeros to match `ros2 msg show`'s typical
  // example output.
  const unknown = (() => {
    const a = new Array(9).fill(0);
    a[0] = -1;
    return a;
  })();
  return {
    header: { stamp: performanceNowToRosTime(sample.t), frame_id: frameId },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    orientation_covariance: unknown,
    angular_velocity: { x: sample.gx, y: sample.gy, z: sample.gz },
    angular_velocity_covariance: new Array(9).fill(0),
    linear_acceleration: { x: sample.ax, y: sample.ay, z: sample.az },
    linear_acceleration_covariance: new Array(9).fill(0),
  };
}

/** sensor_msgs/LaserScan — 360° fan starting at `angle_min` (heading 0
 * by our rover convention) sweeping CCW. `time_increment` and `scan_time`
 * are 0 because we treat each scan as instantaneous. `intensities` is
 * empty (we don't synthesize return strength). */
export type RosLaserScanMessage = {
  header: RosHeader;
  angle_min: number;
  angle_max: number;
  angle_increment: number;
  time_increment: number;
  scan_time: number;
  range_min: number;
  range_max: number;
  ranges: number[];
  intensities: number[];
};

export function buildLaserScanMessage(
  sample: LidarSample,
  maxRange: number,
  frameId = 'laser_link',
): RosLaserScanMessage {
  const bins = sample.ranges.length;
  const angleIncrement = bins > 0 ? (2 * Math.PI) / bins : 0;
  return {
    header: { stamp: performanceNowToRosTime(sample.t), frame_id: frameId },
    angle_min: 0,
    angle_max: 2 * Math.PI - angleIncrement,
    angle_increment: angleIncrement,
    time_increment: 0,
    scan_time: 0,
    range_min: 0.01,
    range_max: maxRange,
    ranges: sample.ranges.slice(),
    intensities: [],
  };
}

/** nav_msgs/Odometry — pose in `odom` frame, twist in `base_link`.
 * Twist is approximated from the pose delta to the previous sample
 * via `prevPose`/`prevT` (caller-supplied). When `prevPose` is null
 * the twist channels are zeroed (first sample of a window). */
export type RosOdometryMessage = {
  header: RosHeader;
  child_frame_id: string;
  pose: {
    pose: {
      position: { x: number; y: number; z: number };
      orientation: { x: number; y: number; z: number; w: number };
    };
    covariance: number[];
  };
  twist: {
    twist: {
      linear: { x: number; y: number; z: number };
      angular: { x: number; y: number; z: number };
    };
    covariance: number[];
  };
};

export function buildOdometryMessage(
  pose: RoverPose,
  tMs: number,
  prev: { pose: RoverPose; t: number } | null,
): RosOdometryMessage {
  // 2D mobile-robot pose: `heading` is yaw about +Y, position lies on
  // the ground plane (y = 0). Convert yaw to a quaternion about Y.
  const halfYaw = pose.heading / 2;
  const orientation = {
    x: 0,
    y: Math.sin(halfYaw),
    z: 0,
    w: Math.cos(halfYaw),
  };
  let lin = { x: 0, y: 0, z: 0 };
  let ang = { x: 0, y: 0, z: 0 };
  if (prev) {
    const dt = Math.max(1e-3, (tMs - prev.t) / 1000);
    const dx = pose.x - prev.pose.x;
    const dz = pose.z - prev.pose.z;
    // Project the world-frame motion onto the rover's body frame, where
    // REP-103 dictates x = forward, y = left, z = up. With our pose
    // convention (heading 0 → forward is world +Z), the forward
    // component is `dx·sin(h) + dz·cos(h)` and left is `dx·cos(h) − dz·sin(h)`.
    const cos = Math.cos(pose.heading);
    const sin = Math.sin(pose.heading);
    const forward = dx * sin + dz * cos;
    const left = dx * cos - dz * sin;
    lin = { x: forward / dt, y: left / dt, z: 0 };
    let dy = pose.heading - prev.pose.heading;
    if (dy > Math.PI) dy -= 2 * Math.PI;
    if (dy < -Math.PI) dy += 2 * Math.PI;
    // Yaw rate appears on the body's z axis (up) per REP-103.
    ang = { x: 0, y: 0, z: dy / dt };
  }
  return {
    header: { stamp: performanceNowToRosTime(tMs), frame_id: 'odom' },
    child_frame_id: 'base_link',
    pose: {
      pose: {
        position: { x: pose.x, y: 0, z: pose.z },
        orientation,
      },
      covariance: new Array(36).fill(0),
    },
    twist: {
      twist: { linear: lin, angular: ang },
      covariance: new Array(36).fill(0),
    },
  };
}

/** Bundle one rover recording window into a JSONL string suitable
 * for writing to `rosbag.jsonl`. Each line is a `{ topic, msg }`
 * pair so a downstream replayer can multiplex topics correctly. */
export type RosBundle = {
  imu: AccelSample[];
  lidar: LidarSample[];
  poses?: { t: number; pose: RoverPose }[];
  lidarMaxRange: number;
};

/** sensor_msgs/JointState — joint position + velocity + effort vectors
 * indexed by `name`. We only fill `position`; velocity is left empty
 * (downstream nodes can finite-difference) and effort is empty
 * (synthetic motion has no torque telemetry). REP-103 doesn't dictate
 * a strict joint-name convention — we use the published Braccio servo
 * labels (M1..M6) so the data lines up with Arduino's own tutorials. */
export type RosJointStateMessage = {
  header: RosHeader;
  name: string[];
  position: number[];
  velocity: number[];
  effort: number[];
};

/** Per-tick joint snapshot — matches the store's `armJointSamples`
 * entry. Six values, M1..M6, in the same units the rest of the arm
 * code uses (joints 0..4 in radians, joint 5 normalized gripper
 * aperture). */
export type ArmJointSample = { t: number; joints: number[] };

export const BRACCIO_JOINT_LABELS: ReadonlyArray<string> = [
  'M1_base',
  'M2_shoulder',
  'M3_elbow',
  'M4_wrist_pitch',
  'M5_wrist_roll',
  'M6_gripper',
];

export function buildJointStateMessage(
  sample: ArmJointSample,
  frameId = 'braccio_base',
): RosJointStateMessage {
  return {
    header: { stamp: performanceNowToRosTime(sample.t), frame_id: frameId },
    name: [...BRACCIO_JOINT_LABELS],
    position: sample.joints.slice(),
    velocity: [],
    effort: [],
  };
}

/** Arm-side ROS bundle — IMU at the end-effector + per-tick joint
 * states. Identical JSONL shape as the rover bundle so downstream
 * loaders can stay generic. */
export type ArmRosBundle = {
  imu: AccelSample[];
  joints: ArmJointSample[];
};

export function buildArmRosJsonl(bundle: ArmRosBundle): string {
  const lines: string[] = [];
  for (const s of bundle.imu) {
    lines.push(
      JSON.stringify({
        topic: '/end_effector/imu',
        msg: buildImuMessage(s, 'end_effector'),
      }),
    );
  }
  for (const s of bundle.joints) {
    lines.push(
      JSON.stringify({
        topic: '/joint_states',
        msg: buildJointStateMessage(s),
      }),
    );
  }
  return lines.join('\n') + '\n';
}

export function buildRoverRosJsonl(bundle: RosBundle): string {
  const lines: string[] = [];
  for (const s of bundle.imu) {
    lines.push(
      JSON.stringify({ topic: '/imu/data', msg: buildImuMessage(s) }),
    );
  }
  for (const s of bundle.lidar) {
    lines.push(
      JSON.stringify({
        topic: '/scan',
        msg: buildLaserScanMessage(s, bundle.lidarMaxRange),
      }),
    );
  }
  if (bundle.poses) {
    let prev: { pose: RoverPose; t: number } | null = null;
    for (const p of bundle.poses) {
      lines.push(
        JSON.stringify({
          topic: '/odom',
          msg: buildOdometryMessage(p.pose, p.t, prev),
        }),
      );
      prev = { pose: p.pose, t: p.t };
    }
  }
  // Trailing newline keeps cat-style streaming friendly.
  return lines.join('\n') + '\n';
}
