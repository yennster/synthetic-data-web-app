# Workflows

Step-by-step instructions for the four modes.

## Recording motion data (manual)

1. Switch to **Motion** mode (default).
2. Pick the object kind in the Object card. Make sure **Webcam control** is on.
3. Show your hand to the camera. The pill in the top-left will read `Hand: tracked`.
4. **Pinch** (thumb + index together) to grab the object — it turns teal and follows your hand.
5. Move / shake / orient your hand. Release the pinch to drop or throw.
6. Click **● Record** before the gesture, **■ Stop** when done.
7. Paste your Edge Impulse API key, set a label, click **⤴ Upload**.
8. After uploading new samples, click **↻ Retrain model** from the upload card to start a Studio retrain job. Motion mode expects a project API key; if the key can access multiple projects, pick a project-specific key.

## Generating motion data procedurally (no webcam needed)

1. Switch to **Motion** mode and (optionally) turn **Webcam control** off so the camera light stays off.
2. Pick the object kind that matches the device you'd put a real IMU on (a soda can, phone slab, etc.).
3. In the **Procedural motions** card: pick a motion class (`drop`, `throw`, `push`, or `shake`), set the **count** (e.g. 50), and tweak **Drop height** range and **Per-drop ms** (record window per sample — 1500 ms covers free-fall + a few bounces).
4. Click **⚡ Generate & upload N samples** if an API key is set, or **⚡ Generate & download N samples** to save a local zip without signing in. The app:
   - Auto-disables hand tracking (so the camera and the script don't fight over the pinch target).
   - For each sample: lifts the object to a random `(x, y, z)` and orientation, performs the chosen motion (free-fall, throw, push, or shake), records the 6-channel IMU trace for the configured duration, and stores it as `{motion}_{i}.json`. The EI sample's `x-label` is set to the motion class so EI auto-classifies the data.
   - With an API key, each sample uploads to your project's `training` (or `testing`) bucket. Without an API key, the samples are bundled into one zip download.
   - Click **■ Stop** at any time to cancel — the runner unwinds at the next checkpoint and packages whatever finished.
   - After an uploaded batch, use **↻ Retrain model** in the upload card to retrain the project with the new samples.
   - Status updates after each sample; failures are tallied separately and don't stop the rest of the batch.

Run the generator once per class to build a balanced multi-class dataset (e.g. 50 `drop` + 50 `throw` + 50 `push` + 50 `shake`). The samples are independent in EI, so the model trains on the variation in initial pose, orientation, and trajectory — not on a single long take.

## Capturing object-detection data

1. Switch to **Object detection** mode.
2. Pick an **Environment** (Studio / Warehouse / White box / Outdoor) in the Scene card. (Optional) Toggle **Conveyor belt**.
3. Add objects from the **Objects** card — pick a kind, type a label, hit **+ Add**. Repeat for as many objects/classes as you need. Edit the label or **Size** inline, toggle **Physics** off if you want it pinned in place; remove with `×`.
4. (Optional) Drop `.usdz` files into the **Import (.usdz)** card to bring in real assets. Each gets its own scale / position / yaw / label and an opt-in physics toggle.
5. Position the **Virtual camera** in the Virtual Camera card. The orange frustum gizmo updates live in the scene; the corner preview shows the captured framing — drag its bottom-right corner to enlarge.
6. Click **📸 Capture frame** for one image, or set a batch count + randomization toggles and click **⚡ Batch (N)** — both single shots and batches download as `.zip` files. Single-frame zips contain the PNG + a matching `bounding_boxes.labels`; batch zips contain every PNG plus one shared sidecar.
7. Or upload directly: paste your API key and click **⤴ Upload N images**. Each image is sent with its bounding boxes attached as the `x-bounding-boxes` header.
8. After uploading new training data, click **↻ Retrain model** in the Upload card. If your API key can access multiple projects, pick the project in the Inference card first.

## Running an Edge Impulse model in-browser

After uploading some captures and training a YOLO / MobileNet / FOMO model in the Edge Impulse Studio:

1. In the studio: **Deployment → WebAssembly → Build**. (Build once; the studio caches the result.)
2. In the app, in the **Inference (Edge Impulse model)** card, click **🔑 List projects**. With your API key set, the app calls `/v1/api/projects` and shows a dropdown.
3. Pick the project, click **⤓ Fetch & load model**. The deployment zip is downloaded over HTTPS, unpacked in-browser, and the model is initialized.
4. Click **▶ Live** to run inference on the virtual-camera preview at ~5 Hz, or **Run once** for a single frame.
5. Bounding boxes and centroid dots appear over the virtual-camera preview. Adjust **Threshold** to filter weak detections.

Alternatively, unzip the WebAssembly deployment locally and upload `edge-impulse-standalone.js` + `edge-impulse-standalone.wasm` via the **From file** field — same result without the API call.

## Capturing visual-anomaly data

1. Switch to **Visual anomaly** mode.
2. Set up scene + camera the same way.
3. Type a batch label (e.g. `normal` or `anomaly`).
4. Capture frames or batches — each image gets the batch label. Bounding boxes are not attached.
5. Save to disk and/or upload to Edge Impulse.

## Capturing robotics data (Rover / Arm)

1. Switch to **Robotics** mode.
2. Choose your robot rig in the **Robot** card: **Rover** (ground vehicle) or **Arm** (Braccio arm).
3. Set up the environment:
   - Add obstacles or pickup targets via the **Scene obstacles** / **Pickup objects** cards.
   - Drag objects manually with `Shift+drag` to position them.
   - Click **Reset scene** to clear the robot's pose and home the arm.
4. **For the Rover:**
   - Pick an **Event** class (`cruise`, `collision`, or `stuck`). This becomes the Edge Impulse label.
   - Select a **Modality**: **Fused (IMU+Lidar)**, **IMU only**, or **Lidar only**.
   - (Optional) Toggle **ROS export** to include canonical ROS 2 `sensor_msgs` in your download/upload.
5. **For the Arm:**
   - Pick a **Trajectory** (`pick_place`, `sweep`, `wave`, `random_pose`, or `draw_circle`).
   - For `pick_place`, click **+ Pickup target** to spawn a small object for the arm to grab.
6. In the **Robotics generator** card, set the batch **count** and **duration** (e.g. 5 samples, 2000 ms each).
7. Click **⚡ Generate & upload N samples** or **⚡ Generate & download N samples**.
   - The rig performs the selected motion while recording 6-channel IMU data (and N-channel lidar for the rover) at 20 Hz.
   - The **Robot POV** overlay shows the front-mounted (rover) or wrist-mounted (arm) camera view.
   - For the rover, impacts with obstacles inject realistic impulses into the accelerometer trace.
8. After uploading, click **↻ Retrain model** to start an Edge Impulse training job.
