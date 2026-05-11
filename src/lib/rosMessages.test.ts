import { describe, expect, it } from 'vitest';
import {
  BRACCIO_JOINT_LABELS,
  buildArmRosJsonl,
  buildImuMessage,
  buildJointStateMessage,
  buildLaserScanMessage,
  buildOdometryMessage,
  buildRoverRosJsonl,
  performanceNowToRosTime,
} from './rosMessages';

describe('performanceNowToRosTime', () => {
  it('splits ms into sec + nanosec', () => {
    expect(performanceNowToRosTime(1234.5)).toEqual({
      sec: 1,
      nanosec: 234500000,
    });
  });

  it('handles zero', () => {
    expect(performanceNowToRosTime(0)).toEqual({ sec: 0, nanosec: 0 });
  });
});

describe('buildImuMessage', () => {
  it('matches sensor_msgs/Imu shape with our convention', () => {
    const msg = buildImuMessage({
      t: 1500,
      ax: 0.1,
      ay: 9.8,
      az: 0.2,
      gx: 0,
      gy: 0,
      gz: 0.05,
    });
    expect(msg.header.frame_id).toBe('imu_link');
    expect(msg.header.stamp).toEqual({ sec: 1, nanosec: 500_000_000 });
    expect(msg.linear_acceleration).toEqual({ x: 0.1, y: 9.8, z: 0.2 });
    expect(msg.angular_velocity).toEqual({ x: 0, y: 0, z: 0.05 });
    // Identity orientation since we don't synthesize a fused orientation.
    expect(msg.orientation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    // Orientation covariance signals "unknown" per spec ([0] = -1).
    expect(msg.orientation_covariance[0]).toBe(-1);
  });
});

describe('buildLaserScanMessage', () => {
  it('reports a 360° scan with bin-aligned angle increments', () => {
    const msg = buildLaserScanMessage(
      { t: 0, ranges: [1, 2, 3, 4] },
      6,
      'laser_link',
    );
    expect(msg.angle_min).toBe(0);
    expect(msg.angle_increment).toBeCloseTo((2 * Math.PI) / 4, 6);
    expect(msg.angle_max).toBeCloseTo(2 * Math.PI - (2 * Math.PI) / 4, 6);
    expect(msg.range_max).toBe(6);
    expect(msg.ranges).toEqual([1, 2, 3, 4]);
    expect(msg.intensities).toEqual([]);
    expect(msg.header.frame_id).toBe('laser_link');
  });

  it('handles an empty bins array gracefully', () => {
    const msg = buildLaserScanMessage({ t: 0, ranges: [] }, 6);
    expect(msg.angle_increment).toBe(0);
    expect(msg.ranges).toEqual([]);
  });
});

describe('buildOdometryMessage', () => {
  it('encodes yaw as a Y-axis quaternion and zeroes twist on the first sample', () => {
    const msg = buildOdometryMessage(
      { x: 1, z: 2, heading: Math.PI / 2 },
      0,
      null,
    );
    // heading π/2 → quaternion about Y with sin(π/4), cos(π/4)
    expect(msg.pose.pose.orientation.y).toBeCloseTo(Math.sin(Math.PI / 4), 6);
    expect(msg.pose.pose.orientation.w).toBeCloseTo(Math.cos(Math.PI / 4), 6);
    expect(msg.pose.pose.position).toEqual({ x: 1, y: 0, z: 2 });
    // First sample → twist is zero.
    expect(msg.twist.twist.linear).toEqual({ x: 0, y: 0, z: 0 });
    expect(msg.twist.twist.angular).toEqual({ x: 0, y: 0, z: 0 });
    expect(msg.child_frame_id).toBe('base_link');
  });

  it('approximates body-frame twist from pose deltas on subsequent samples', () => {
    const prev = { pose: { x: 0, z: 0, heading: 0 }, t: 0 };
    const msg = buildOdometryMessage(
      { x: 0, z: 1, heading: 0 },
      1000,
      prev,
    );
    // Moved 1 m forward (+Z world) over 1 s with heading 0 → in
    // base_link's REP-103 frame (x=forward), linear.x = 1 m/s.
    expect(msg.twist.twist.linear.x).toBeCloseTo(1, 4);
    expect(msg.twist.twist.linear.y).toBeCloseTo(0, 6);
    expect(msg.twist.twist.angular.z).toBeCloseTo(0, 6);
  });

  it('rotates linear twist when heading is non-zero', () => {
    // Same world delta but heading rotated to π/2 (rover facing +X) —
    // in body frame, that motion is now lateral. With the right-hand
    // convention (forward=+x, left=+y, up=+z), a heading-π/2 rover
    // moving in world +Z is moving to its right, which is -y in
    // body frame.
    const prev = { pose: { x: 0, z: 0, heading: Math.PI / 2 }, t: 0 };
    const msg = buildOdometryMessage(
      { x: 0, z: 1, heading: Math.PI / 2 },
      1000,
      prev,
    );
    expect(msg.twist.twist.linear.x).toBeCloseTo(0, 4);
    expect(msg.twist.twist.linear.y).toBeCloseTo(-1, 4);
  });
});

describe('buildRoverRosJsonl', () => {
  it('emits one message per IMU and lidar sample on canonical topics', () => {
    const jsonl = buildRoverRosJsonl({
      imu: [
        { t: 0, ax: 0, ay: 9.81, az: 0, gx: 0, gy: 0, gz: 0 },
        { t: 50, ax: 0.1, ay: 9.8, az: 0, gx: 0, gy: 0, gz: 0 },
      ],
      lidar: [{ t: 50, ranges: [1, 1, 1, 1] }],
      lidarMaxRange: 5,
    });
    const lines = jsonl.trim().split('\n');
    expect(lines.length).toBe(3); // 2 IMU + 1 LaserScan
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.filter((p) => p.topic === '/imu/data').length).toBe(2);
    expect(parsed.filter((p) => p.topic === '/scan').length).toBe(1);
  });
});

describe('buildJointStateMessage', () => {
  it('fills the canonical sensor_msgs/JointState shape with Braccio labels', () => {
    const msg = buildJointStateMessage({
      t: 1000,
      joints: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    });
    expect(msg.header.frame_id).toBe('braccio_base');
    expect(msg.name).toEqual([...BRACCIO_JOINT_LABELS]);
    expect(msg.position).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    // Velocity + effort are explicitly empty; downstream nodes can
    // finite-difference if they want velocity.
    expect(msg.velocity).toEqual([]);
    expect(msg.effort).toEqual([]);
  });
});

describe('buildArmRosJsonl', () => {
  it('multiplexes IMU and joint-state samples onto separate topics', () => {
    const jsonl = buildArmRosJsonl({
      imu: [
        { t: 0, ax: 0, ay: 9.81, az: 0, gx: 0, gy: 0, gz: 0 },
        { t: 50, ax: 0.1, ay: 9.8, az: 0, gx: 0, gy: 0, gz: 0 },
      ],
      joints: [
        { t: 0, joints: [0, 0, 0, 0, 0, 0] },
        { t: 50, joints: [0.1, 0, 0, 0, 0, 0] },
      ],
    });
    const lines = jsonl.trim().split('\n');
    expect(lines.length).toBe(4);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.filter((p) => p.topic === '/end_effector/imu').length).toBe(2);
    expect(parsed.filter((p) => p.topic === '/joint_states').length).toBe(2);
    // The IMU frame_id is the end-effector — matches the arm's
    // physical IMU mount location (the gripper carrier).
    const firstImu = parsed.find((p) => p.topic === '/end_effector/imu');
    expect(firstImu.msg.header.frame_id).toBe('end_effector');
  });
});
