/**
 * normalization.js
 * AI Kickboxing Coach Core Logic Engine
 *
 * 役割:
 * 1. ノイズ除去 (One Euro Filter)
 * 2. 重心推定 (Segmental Mass Distribution)
 * 3. 座標正規化 (Translation, Scaling, Rotation)
 * 4. 特徴量抽出 (Feature Extraction V3.1)
 */

class NormalizationEngine {
    constructor() {
        // One Euro Filter の設定
        this.minCutoff = 1.0; // 低速時のカットオフ周波数 (ブレ除去強度)
        this.beta = 0.0;      // 高速時の追従性係数 (高いほど追従)
        this.dCutoff = 1.0;   // 派生カットオフ

        // フィルタの状態保持用 (各ランドマーク33点 x 3次元)
        this.filters = [];
        for (let i = 0; i < 33; i++) {
            this.filters.push({
                x: new OneEuroFilter(30, this.minCutoff, this.beta, this.dCutoff),
                y: new OneEuroFilter(30, this.minCutoff, this.beta, this.dCutoff),
                z: new OneEuroFilter(30, this.minCutoff, this.beta, this.dCutoff)
            });
        }
    }

    /**
     * メイン処理: 生のPoseデータを受け取り、正規化された特徴量ベクトルを返す
     * @param {Array} landmarks - MediaPipe poseWorldLandmarks
     * @param {Number} timestamp - 動画の現在時刻(秒)
     * @returns {Array|null} featureVector - V3.1形式の24要素配列
     */
    process(landmarks, timestamp) {
        if (!landmarks || landmarks.length < 33) return null;

        // 1. ノイズ除去 (平滑化)
        const smoothedPose = this.applyFilter(landmarks, timestamp);

        // 2. 重心推定 (COG)
        const cog = this.calculateCOG(smoothedPose);

        // 3. 座標正規化 (原点・スケール・回転)
        const normalizedData = this.normalizePose(smoothedPose, cog);

        // 4. 特徴量抽出 (V3.1)
        return this.extractFeaturesV3(normalizedData.pose, normalizedData.cog);
    }

    // =========================================================
    // 1. ノイズ除去 (One Euro Filter Wrapper)
    // =========================================================
    applyFilter(landmarks, timestamp) {
        return landmarks.map((pt, i) => {
            if (i >= 33) return pt; // 範囲外ガード
            return {
                x: this.filters[i].x.filter(pt.x, timestamp),
                y: this.filters[i].y.filter(pt.y, timestamp),
                z: this.filters[i].z.filter(pt.z, timestamp),
                visibility: pt.visibility || pt.v || 0
            };
        });
    }

    // =========================================================
    // 2. 重心推定 (Segmental Mass Distribution)
    // =========================================================
    calculateCOG(pose) {
        // Dempsterの身体分節パラメータに基づく質量比率
        const segments = [
            { indices: [0], weight: 0.07 }, // 頭 (鼻で代用)
            // 胴体 (肩中点と腰中点から算出するため、後で計算)
            { indices: [11, 13], weight: 0.028 }, // 上腕 (L)
            { indices: [12, 14], weight: 0.028 }, // 上腕 (R)
            { indices: [13, 15], weight: 0.016 }, // 前腕 (L)
            { indices: [14, 16], weight: 0.016 }, // 前腕 (R)
            { indices: [15, 17, 19, 21], weight: 0.006 }, // 手 (L) - 代表点平均
            { indices: [16, 18, 20, 22], weight: 0.006 }, // 手 (R)
            { indices: [23, 25], weight: 0.10 }, // 大腿 (L)
            { indices: [24, 26], weight: 0.10 }, // 大腿 (R)
            { indices: [25, 27], weight: 0.0465 }, // 下腿 (L)
            { indices: [26, 28], weight: 0.0465 }, // 下腿 (R)
            { indices: [27, 29, 31], weight: 0.0145 }, // 足 (L)
            { indices: [28, 30, 32], weight: 0.0145 }  // 足 (R)
        ];

        let totalMass = 0;
        let sumX = 0, sumY = 0, sumZ = 0;

        // 胴体 (Trunk) の計算: 肩中点と腰中点の平均位置とする
        // 質量: 約50% (頭部7%を除く残りの体幹部)
        const shoulderMid = this.getMidPoint(pose[11], pose[12]);
        const hipMid = this.getMidPoint(pose[23], pose[24]);
        const trunkCenter = this.getMidPoint(shoulderMid, hipMid);
        const trunkWeight = 0.50;

        sumX += trunkCenter.x * trunkWeight;
        sumY += trunkCenter.y * trunkWeight;
        sumZ += trunkCenter.z * trunkWeight;
        totalMass += trunkWeight;

        // 各セグメントの計算
        segments.forEach(seg => {
            let segX = 0, segY = 0, segZ = 0;
            seg.indices.forEach(idx => {
                segX += pose[idx].x;
                segY += pose[idx].y;
                segZ += pose[idx].z;
            });
            // パーツの中心点
            segX /= seg.indices.length;
            segY /= seg.indices.length;
            segZ /= seg.indices.length;

            sumX += segX * seg.weight;
            sumY += segY * seg.weight;
            sumZ += segZ * seg.weight;
            totalMass += seg.weight;
        });

        return {
            x: sumX / totalMass,
            y: sumY / totalMass,
            z: sumZ / totalMass
        };
    }

    // =========================================================
    // 3. 座標正規化 (Core Logic)
    // =========================================================
    normalizePose(pose, cog) {
        // A. 原点シフト: 腰の中点(Hip Center)を (0,0,0) にする
        const hipCenter = this.getMidPoint(pose[23], pose[24]);

        const translatedPose = pose.map(p => ({
            x: p.x - hipCenter.x,
            y: p.y - hipCenter.y,
            z: p.z - hipCenter.z,
            visibility: p.visibility
        }));
        // COGもシフト
        let normCog = {
            x: cog.x - hipCenter.x,
            y: cog.y - hipCenter.y,
            z: cog.z - hipCenter.z
        };

        // B. 回転補正: 両腰を結ぶ線が X軸 と平行になるように Y軸回転
        // 左腰(23) - 右腰(24) ベクトル
        const leftHip = translatedPose[23];
        const rightHip = translatedPose[24];
        const dx = leftHip.x - rightHip.x;
        const dz = leftHip.z - rightHip.z;

        // 回転角度 (正面を向くように)
        const angleY = Math.atan2(dz, dx); // Z, X

        const rotateY = (p, theta) => {
            return {
                x: p.x * Math.cos(theta) - p.z * Math.sin(theta),
                y: p.y,
                z: p.x * Math.sin(theta) + p.z * Math.cos(theta),
                visibility: p.visibility
            };
        };

        const rotatedPose = translatedPose.map(p => rotateY(p, -angleY));
        normCog = rotateY(normCog, -angleY);

        // C. スケール補正: 脊柱長 (Spine Length) を 1.0 にする
        // 脊柱長 = 腰中点(原点) から 首(肩中点) までの距離
        // ※回転後の座標で計算
        const rShoulderMid = this.getMidPoint(rotatedPose[11], rotatedPose[12]);
        const rHipMid = { x: 0, y: 0, z: 0 }; // 原点
        const spineLength = this.getDistance(rShoulderMid, rHipMid) || 1.0; // 0除算防止

        const scaledPose = rotatedPose.map(p => ({
            x: p.x / spineLength,
            y: p.y / spineLength,
            z: p.z / spineLength,
            visibility: p.visibility
        }));
        normCog = {
            x: normCog.x / spineLength,
            y: normCog.y / spineLength,
            z: normCog.z / spineLength
        };

        return { pose: scaledPose, cog: normCog };
    }

    // =========================================================
    // 4. 特徴量抽出 (V3.1 Implementation)
    // =========================================================
    extractFeaturesV3(pose, cog) {
        // 配列配列ではなく、フラットな数値配列(24要素)を返す
        const features = [];

        // --- A. 軌跡・形状 (Trajectories) [18要素] ---
        // 1. 左手 (19)
        features.push(pose[19].x, pose[19].y, pose[19].z);
        // 2. 右手 (20)
        features.push(pose[20].x, pose[20].y, pose[20].z);
        // 3. 左足 (31)
        features.push(pose[31].x, pose[31].y, pose[31].z);
        // 4. 右足 (32)
        features.push(pose[32].x, pose[32].y, pose[32].z);
        // 5. 左膝 (25)
        features.push(pose[25].x, pose[25].y, pose[25].z);
        // 6. 右膝 (26)
        features.push(pose[26].x, pose[26].y, pose[26].z);

        // --- B. 体幹・回旋 (Body Mechanics) [2要素] ---
        // 7. 骨盤の回旋角 (Hip Rotation)
        // 両腰ベクトル(24->23)とX軸との角度...だが、正規化でX軸に合わせてあるため、
        // ここでは「捻転」を見るために、脊柱を軸とした回転を見る必要があるが、
        // 簡易的に「正規化後の肩のねじれ」を見る。
        // 正規化ステップで腰はX軸平行(0度)になっているため、肩の角度がそのまま「捻転差(X-Factor)」になる。
        const shoulderVec = {
            x: pose[11].x - pose[12].x,
            z: pose[11].z - pose[12].z
        };
        const shoulderAngle = Math.atan2(shoulderVec.z, shoulderVec.x) * (180 / Math.PI);

        // 骨盤は正規化で0度だが、動作中の「絶対的な回転」を知りたい場合は、
        // 正規化前の angleY を保存しておく必要がある。
        // しかしV3仕様では「脊柱軸に対する回転」なので、相対角度で良い。
        // ここでは「肩の回旋(捻転差)」を入れる。
        features.push(0); // 腰は基準なので0 (捻転差の基準)
        features.push(shoulderAngle); // 捻転差

        // --- C. 重心・バランス (Stability) [2要素] ---
        // 9. COG偏差 (X, Z)
        // 原点(腰中点)からの重心のズレ
        features.push(cog.x, cog.z);

        // --- D. ガード・防御 (Guard Integrity) [2要素] ---
        // 10. 左手-頭部距離
        // 頭部(鼻0)と左手(19)の距離
        features.push(this.getDistance(pose[0], pose[19]));
        // 11. 右手-頭部距離
        features.push(this.getDistance(pose[0], pose[20]));

        return features;
    }

    // --- Helpers ---
    getMidPoint(p1, p2) {
        return {
            x: (p1.x + p2.x) / 2,
            y: (p1.y + p2.y) / 2,
            z: (p1.z + p2.z) / 2
        };
    }

    getDistance(p1, p2) {
        return Math.sqrt(
            Math.pow(p1.x - p2.x, 2) +
            Math.pow(p1.y - p2.y, 2) +
            Math.pow(p1.z - p2.z, 2)
        );
    }
}

// =========================================================
// One Euro Filter Implementation
// (Minimal implementation for standalone use)
// =========================================================
class OneEuroFilter {
    constructor(freq, minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
        this.freq = freq;
        this.minCutoff = minCutoff;
        this.beta = beta;
        this.dCutoff = dCutoff;
        this.x = new LowPassFilter(this.alpha(minCutoff));
        this.dx = new LowPassFilter(this.alpha(dCutoff));
        this.lastTime = undefined;
    }

    alpha(cutoff) {
        const te = 1.0 / this.freq;
        const tau = 1.0 / (2 * Math.PI * cutoff);
        return 1.0 / (1.0 + tau / te);
    }

    filter(value, timestamp) {
        // update the sampling frequency based on timestamps
        if (this.lastTime !== undefined && timestamp !== undefined) {
            this.freq = 1.0 / (timestamp - this.lastTime);
        }
        this.lastTime = timestamp;
        const dvalue = this.x.hasLastRawValue() ? (value - this.x.lastRawValue()) * this.freq : 0.0;
        const edvalue = this.dx.filterWithAlpha(dvalue, this.alpha(this.dCutoff));
        const cutoff = this.minCutoff + this.beta * Math.abs(edvalue);
        return this.x.filterWithAlpha(value, this.alpha(cutoff));
    }
}

class LowPassFilter {
    constructor(alpha, initValue = 0) {
        this.y = initValue;
        this.s = initValue;
        this.s = undefined;
        this.alpha = alpha;
    }

    filterWithAlpha(value, alpha) {
        this.alpha = alpha;
        return this.filter(value);
    }

    filter(value) {
        let result;
        if (this.s === undefined) {
            result = value;
        } else {
            result = this.alpha * value + (1.0 - this.alpha) * this.s;
        }
        this.s = result;
        this.w = value;
        return result;
    }

    hasLastRawValue() {
        return this.w !== undefined;
    }

    lastRawValue() {
        return this.w;
    }
}

// ブラウザ環境とNode環境の両対応
if (typeof window !== 'undefined') {
    window.NormalizationEngine = NormalizationEngine;
} else if (typeof module !== 'undefined') {
    module.exports = NormalizationEngine;
}
