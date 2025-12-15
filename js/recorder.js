// recorder.js
// スマホでの手本データ作成専用ロジック (Metrics & Mirroring 対応)

const videoElement = document.getElementById('inputVideo');
const canvasElement = document.getElementById('outputCanvas');
const canvasCtx = canvasElement.getContext('2d');
const statusMsg = document.getElementById('statusMsg');

// UI Elements
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const toEditBtn = document.getElementById('toEditBtn');
const countdownDisplay = document.getElementById('countdownDisplay');

// Edit Modal Elements
const editModal = document.getElementById('editModal');
const closeEditBtn = document.getElementById('closeEditBtn');
const previewCanvas = document.getElementById('previewCanvas');
const previewCtx = previewCanvas.getContext('2d');
const previewPlayBtn = document.getElementById('previewPlayBtn');
const rangeStart = document.getElementById('rangeStart');
const rangeEnd = document.getElementById('rangeEnd');
const sliderRange = document.getElementById('sliderRange');
const startFrameText = document.getElementById('startFrameText');
const endFrameText = document.getElementById('endFrameText');

// Input Fields
const techNameInput = document.getElementById('techNameInput');
const performerName = document.getElementById('performerName');
const heightInput = document.getElementById('heightInput');
const stanceInputs = document.getElementsByName('stance');
const generateBtn = document.getElementById('generateBtn');
const copyJsonBtn = document.getElementById('copyJsonBtn');
const jsonPreview = document.getElementById('jsonPreview');
const resultArea = document.getElementById('resultArea');

// Logic State
let isRecording = false;
let poseHistory = [];
let normalizationEngine = new NormalizationEngine();
let pose = null;
let previewAnimationId;
let isPreviewPlaying = false;

// Init
function init() {
    pose = new Pose({locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`});
    pose.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });
    pose.onResults(onResults);
    startBackCamera();
}

async function startBackCamera() {
    const constraints = {
        audio: false,
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    };
    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        videoElement.srcObject = stream;
        videoElement.onloadedmetadata = () => {
            videoElement.play();
            requestAnimationFrame(processVideoFrame);
        };
    } catch (err) {
        console.error(err);
        alert("カメラ起動失敗: HTTPS接続を確認してください");
    }
}

async function processVideoFrame() {
    if (videoElement.paused || videoElement.ended) return;
    if (canvasElement.width !== videoElement.videoWidth) {
        canvasElement.width = videoElement.videoWidth;
        canvasElement.height = videoElement.videoHeight;
    }
    await pose.send({image: videoElement});
    requestAnimationFrame(processVideoFrame);
}

function onResults(results) {
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    if (results.poseLandmarks) {
        drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, {color: '#00FF00', lineWidth: 2});
        drawLandmarks(canvasCtx, results.poseLandmarks, {color: '#FF0000', lineWidth: 1});
        checkVisibility(results.poseLandmarks);

        if (isRecording && results.poseWorldLandmarks) {
            poseHistory.push({
                time: Date.now(),
                pose: results.poseWorldLandmarks,
                screenPose: results.poseLandmarks
            });
        }
    }
    canvasCtx.restore();
}

function checkVisibility(landmarks) {
    const leftFoot = landmarks[31];
    const rightFoot = landmarks[32];
    if (!leftFoot || !rightFoot || leftFoot.visibility < 0.5 || rightFoot.visibility < 0.5) {
        statusMsg.textContent = "⚠️ 足が見えません！";
        statusMsg.className = "absolute bottom-10 text-lg font-bold text-red-400 drop-shadow-md bg-black/70 px-3 py-1 rounded border border-red-500";
    } else {
        if(!isRecording) {
            statusMsg.textContent = "✅ 撮影OK";
            statusMsg.className = "absolute bottom-10 text-lg font-bold text-green-400 drop-shadow-md bg-black/50 px-3 py-1 rounded";
        } else {
            statusMsg.textContent = "🔴 録画中...";
            statusMsg.className = "absolute bottom-10 text-lg font-bold text-red-500 animate-pulse drop-shadow-md bg-black/50 px-3 py-1 rounded";
        }
    }
}

// Recording Controls
recordBtn.addEventListener('click', startCountdown);
function startCountdown() {
    recordBtn.classList.add('hidden');
    countdownDisplay.classList.remove('hidden');
    let count = 3;
    countdownDisplay.textContent = count;
    const timer = setInterval(() => {
        count--;
        if (count > 0) { countdownDisplay.textContent = count; }
        else { clearInterval(timer); countdownDisplay.classList.add('hidden'); startRecording(); }
    }, 1000);
}
function startRecording() {
    isRecording = true;
    poseHistory = [];
    stopBtn.classList.remove('hidden');
}
stopBtn.addEventListener('click', () => {
    isRecording = false;
    stopBtn.classList.add('hidden');
    resetBtn.classList.remove('hidden');
    toEditBtn.classList.remove('hidden');
    statusMsg.textContent = `💾 ${poseHistory.length} Frames`;
});
resetBtn.addEventListener('click', () => {
    poseHistory = [];
    resetBtn.classList.add('hidden');
    toEditBtn.classList.add('hidden');
    recordBtn.classList.remove('hidden');
    statusMsg.textContent = "🧍 全身を映してください";
});

// Editor Controls
toEditBtn.addEventListener('click', () => {
    if (poseHistory.length < 10) { alert("データが短すぎます"); return; }
    openEditor();
});
function openEditor() {
    editModal.classList.remove('hidden');
    const max = poseHistory.length - 1;
    rangeStart.max = max; rangeEnd.max = max;
    rangeStart.value = 0; rangeEnd.value = max;
    updateSliderUI();
    drawPreviewFrame(0);
}
function updateSliderUI() {
    const min = parseInt(rangeStart.value);
    const max = parseInt(rangeEnd.value);

    // 交差防止
    if (min > max - 5) {
        rangeStart.value = max - 5;
    }

    const total = parseInt(rangeStart.max);

    // バーの位置更新
    const leftPct = (parseInt(rangeStart.value) / total) * 100;
    const rightPct = (parseInt(rangeEnd.value) / total) * 100;

    sliderRange.style.left = leftPct + "%";
    sliderRange.style.right = (100 - rightPct) + "%";

    // ★ここを変更: フレーム数(30fps)を秒数に変換して表示
    const startSec = (parseInt(rangeStart.value) / 30).toFixed(2);
    const endSec = (parseInt(rangeEnd.value) / 30).toFixed(2);

    startFrameText.textContent = `${startSec}s`; // 表示例: 0.50s
    endFrameText.textContent = `${endSec}s`;     // 表示例: 2.10s
}
rangeStart.addEventListener('input', () => { updateSliderUI(); drawPreviewFrame(parseInt(rangeStart.value)); });
rangeEnd.addEventListener('input', () => { updateSliderUI(); drawPreviewFrame(parseInt(rangeEnd.value)); });

function drawPreviewFrame(index) {
    if (!poseHistory[index]) return;
    const frame = poseHistory[index];
    previewCanvas.width = 300;
    previewCanvas.height = 300 * (canvasElement.height / canvasElement.width);
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    if (frame.screenPose) {
        drawConnectors(previewCtx, frame.screenPose, POSE_CONNECTIONS, {color: '#00FF00', lineWidth: 2});
        drawLandmarks(previewCtx, frame.screenPose, {color: '#FF0000', lineWidth: 1});
    }
}
previewPlayBtn.addEventListener('click', () => {
    if (isPreviewPlaying) { cancelAnimationFrame(previewAnimationId); isPreviewPlaying = false; previewPlayBtn.innerHTML = '<span class="material-icons-round text-4xl">play_arrow</span>'; }
    else { isPreviewPlaying = true; previewPlayBtn.innerHTML = '<span class="material-icons-round text-4xl">pause</span>'; playPreviewLoop(); }
});
function playPreviewLoop() {
    let current = parseInt(rangeStart.value);
    const end = parseInt(rangeEnd.value);
    const loop = () => {
        if (!isPreviewPlaying) return;
        drawPreviewFrame(current);
        current++;
        if (current > end) current = parseInt(rangeStart.value);
        setTimeout(() => { previewAnimationId = requestAnimationFrame(loop); }, 33);
    };
    loop();
}

// ==========================================
// ★ Logic: Analyze & Generate JSON
// ==========================================
generateBtn.addEventListener('click', () => {
    const name = techNameInput.value.trim();
    if (!name) { alert("技の名前を入力してください"); return; }

    const start = parseInt(rangeStart.value);
    const end = parseInt(rangeEnd.value);
    const trimmedData = poseHistory.slice(start, end + 1);
    if (trimmedData.length < 5) { alert("選択範囲が短すぎます"); return; }

    // 設定取得
    const isSouthpaw = Array.from(stanceInputs).find(r => r.checked).value === 'southpaw';
    const heightCm = parseInt(heightInput.value) || 170;

    // 1. サウスポーならミラーリング + 前処理
    const processedHistory = trimmedData.map(frame => {
        let pose = JSON.parse(JSON.stringify(frame.pose)); // Deep Copy
        if (isSouthpaw) {
            pose = mirrorPose(pose);
        }
        return {
            time: frame.time,
            pose: pose
        };
    });

    // 2. Metrics計算 (正規化前に、実測値として計算)
    const metrics = calculateMetrics(processedHistory, heightCm);

    // 3. 正規化 & 100フレーム化
    const v3Data = generateV3Data(processedHistory);

    // 4. 出力生成
    const output = {
        name: name,
        performer: performerName.value.trim() || "Unknown",
        stance_original: isSouthpaw ? "southpaw" : "orthodox",
        height_cm: heightCm,
        created_at: new Date().toISOString(),
        version: "3.1",
        metrics: metrics,   // ★速度・時間データ
        frames: v3Data.length,
        fingerprint: v3Data // ★形状データ
    };

    resultArea.classList.remove('hidden');
    jsonPreview.textContent = JSON.stringify(output, null, 2);
    copyJsonBtn.disabled = false;

    if (sendToPcBtn) {
        sendToPcBtn.disabled = false;
        sendToPcBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
});

// サウスポーをオーソドックスに変換 (X軸反転 & 左右入れ替え)
function mirrorPose(pose) {
    // 1. X座標を反転
    pose.forEach(pt => pt.x = pt.x * -1);

    // 2. 左右のIDを入れ替え (MediaPipe Pose Landmarks)
    const swapPairs = [
        [11, 12], [13, 14], [15, 16], // 腕
        [17, 18], [19, 20], [21, 22], // 手
        [23, 24], [25, 26], [27, 28], // 足
        [29, 30], [31, 32]            // 足先
    ];

    swapPairs.forEach(([left, right]) => {
        const temp = pose[left];
        pose[left] = pose[right];
        pose[right] = temp;
    });
    return pose;
}

// 統計情報計算（行き・帰りの分離 & 自動パーツ判定版）
function calculateMetrics(history, heightCm) {
    if (history.length < 5) return {};

    // 1. 基準となる「体の中心（腰の中点）」を全フレームで計算しておく
    // 2. 「一番大きく動いたパーツ」を特定する
    const parts = [
        { id: 19, name: 'left_hand' },
        { id: 20, name: 'right_hand' },
        { id: 31, name: 'left_foot' },
        { id: 32, name: 'right_foot' }
    ];

    let maxExtension = 0;
    let activePartId = 20; // デフォルト右手
    let activePartName = 'right_hand';
    let apexFrameIndex = 0; // 最も伸びたフレーム番号

    // 全パーツを走査して、最も「体幹から遠ざかった」パーツと、その瞬間を探す
    parts.forEach(part => {
        let localMaxDist = 0;
        let localApexIndex = 0;

        history.forEach((frame, i) => {
            const hipCenter = getMidPoint(frame.pose[23], frame.pose[24]);
            const limb = frame.pose[part.id];
            // 腰からの距離
            const dist = Math.sqrt(
                Math.pow(limb.x - hipCenter.x, 2) +
                Math.pow(limb.y - hipCenter.y, 2) +
                Math.pow(limb.z - hipCenter.z, 2)
            );

            if (dist > localMaxDist) {
                localMaxDist = dist;
                localApexIndex = i;
            }
        });

        // このパーツがこれまでの候補より大きく動いていれば、これを「主動作」とする
        // (ただし、足と手の距離感は違うので、単純比較だと足が勝ちやすいが、
        //  動作の変化量(レンジ)を見るべき。今回は簡易的に「最大距離」で判定)
        if (localMaxDist > maxExtension) {
            maxExtension = localMaxDist;
            activePartId = part.id;
            activePartName = part.name;
            apexFrameIndex = localApexIndex;
        }
    });

    // 3. 行き(Outbound)と帰り(Return)の速度を計算
    const heightScale = heightCm / 175.0; // 身長補正

    const speedOut = calculateMaxSpeedInRange(history, 0, apexFrameIndex, activePartId, heightScale);
    const speedRet = calculateMaxSpeedInRange(history, apexFrameIndex, history.length - 1, activePartId, heightScale);

    const startTime = history[0].time;
    const endTime = history[history.length - 1].time;
    const durationSec = (endTime - startTime) / 1000;

    return {
        duration_sec: parseFloat(durationSec.toFixed(2)),
        active_part: activePartName,           // 自動判定されたパーツ
        max_speed_outbound: speedOut,          // 行きの速さ (m/s)
        max_speed_return: speedRet,            // 帰りの速さ (m/s)
        apex_frame: apexFrameIndex             // 折り返し地点 (0-100のインデックスではなく、元配列のインデックス)
    };
}

// 指定範囲内での最大速度を求めるヘルパー関数
function calculateMaxSpeedInRange(history, startIndex, endIndex, partId, scale) {
    let maxSpeed = 0;
    if (endIndex <= startIndex) return 0;

    for (let i = startIndex + 1; i <= endIndex; i++) {
        const dt = (history[i].time - history[i-1].time) / 1000;
        if (dt <= 0) continue;

        const p1 = history[i-1].pose[partId];
        const p2 = history[i].pose[partId];

        const dist = Math.sqrt(
            Math.pow(p2.x - p1.x, 2) +
            Math.pow(p2.y - p1.y, 2) +
            Math.pow(p2.z - p1.z, 2)
        );

        // 瞬間速度 (m/s)
        const speed = (dist * scale) / dt;

        // ノイズ除去: 人体の限界を超えた異常値(例: 20m/s以上)はカットするフィルタを入れるとより良い
        if (speed < 25.0 && speed > maxSpeed) {
            maxSpeed = speed;
        }
    }
    return parseFloat(maxSpeed.toFixed(2));
}

// 腰の中点を計算するヘルパー
function getMidPoint(p1, p2) {
    return {
        x: (p1.x + p2.x) / 2,
        y: (p1.y + p2.y) / 2,
        z: (p1.z + p2.z) / 2
    };
}

function generateV3Data(history) {
    const processed = [];
    history.forEach((frame, i) => {
        const timeSec = i * (1/30);
        // Poseは既にミラーリング済み
        const features = normalizationEngine.process(frame.pose, timeSec);
        if(features) processed.push(features);
    });
    return resampleTimeSeries(processed, 100);
}

function resampleTimeSeries(data, targetLen) {
    if (data.length === 0) return [];
    if (data.length === 1) return new Array(targetLen).fill(data[0]);
    const resampled = [];
    const step = (data.length - 1) / (targetLen - 1);
    for (let i = 0; i < targetLen; i++) {
        const originalIndex = i * step;
        const indexLow = Math.floor(originalIndex);
        const indexHigh = Math.min(Math.ceil(originalIndex), data.length - 1);
        const ratio = originalIndex - indexLow;
        const frameLow = data[indexLow];
        const frameHigh = data[indexHigh];
        const newFrame = frameLow.map((val, idx) => val + (frameHigh[idx] - val) * ratio);
        resampled.push(newFrame);
    }
    return resampled;
}

closeEditBtn.addEventListener('click', () => {
    editModal.classList.add('hidden');
    cancelAnimationFrame(previewAnimationId);
    isPreviewPlaying = false;
});
copyJsonBtn.addEventListener('click', () => {
    const text = jsonPreview.textContent;
    navigator.clipboard.writeText(text).then(() => { alert("コピーしました！"); }).catch(() => { alert("コピー失敗"); });
});

// ★追加: PCサーバーへ直接送信するボタンの処理
// (HTML側に id="sendToPcBtn" のボタンを追加する必要があります)
const sendToPcBtn = document.getElementById('sendToPcBtn'); // 後でHTMLに追加します

if (sendToPcBtn) {
    sendToPcBtn.addEventListener('click', async () => {
        // 現在プレビュー中のJSONデータを取得
        const jsonText = jsonPreview.textContent;
        if (!jsonText || jsonText === "waiting...") {
            alert("データがありません。先に「JSON生成」をしてください。");
            return;
        }

        try {
            const data = JSON.parse(jsonText);

            // ボタンを一時的に無効化
            sendToPcBtn.disabled = true;
            sendToPcBtn.textContent = "送信中...";

            // PCのサーバーにPOST送信
            // (ngrok経由でも、相対パス '/api/...' でサーバーに届きます)
            const response = await fetch('/api/save-fingerprint', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            const result = await response.json();

            if (result.success) {
                alert(`PCに保存しました！\nファイル名: ${result.filename}`);
            } else {
                alert("保存エラー: " + result.error);
            }

        } catch (e) {
            console.error(e);
            alert("送信に失敗しました。\n通信環境を確認してください。");
        } finally {
            sendToPcBtn.disabled = false;
            sendToPcBtn.innerHTML = '<span class="material-icons-round">cloud_upload</span> PCへ保存';
        }
    });
}

// init
init();
