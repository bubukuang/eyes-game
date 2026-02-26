// --- 1. 初始化 ---
const videoElement = document.getElementById('inputVideo');
const overlayCanvas = document.getElementById('overlayCanvas');
const overlayCtx = overlayCanvas.getContext('2d');

const canvasElement = document.getElementById('gameCanvas');
const canvasCtx = canvasElement.getContext('2d');
const startBtn = document.getElementById('start-btn');
const startScreen = document.getElementById('start-screen');
const uiLayer = document.getElementById('ui-layer');
const hud = document.getElementById('hud');
const scoreEl = document.getElementById('score');
const statusText = document.getElementById('status-text');
const chargeBarContainer = document.getElementById('charge-bar-container');
const chargeBar = document.getElementById('charge-bar');

let isGameRunning = false;
let score = 0;
let lastTime = 0;
let nosePos = { x: 0.5, y: 0.5 };
let isEyesClosed = false;
let modelLoaded = false;

// 遊戲參數
const EYE_CLOSED_THRESHOLD = 0.012; 
const BLINK_FILTER_TIME = 0.2; 
const FULL_CHARGE_TIME = 2.0; 
const SPAWN_RATE = 800; 

// [修改] 增加判定寬容度 (像素)，讓目標更容易被瞄準
const HIT_BUFFER = 70; 

let blinkTimer = 0;   
let chargeTimer = 0;  
let isCharging = false;
let isFullyCharged = false;
let timeDilation = 1.0; 
let lastSpawnTime = 0;

let targets = [];
let particles = [];
let cursor = { x: 0, y: 0, radius: 15 };

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const FRUITS = ["🍎", "🍌", "🍇", "🍉", "🍒", "🍊", "🍍", "🥭"];

// --- 2. MediaPipe ---
const faceMesh = new FaceMesh({locateFile: (file) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
}});
faceMesh.setOptions({
    maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5
});
faceMesh.onResults(onResults);

// --- 3. 啟動與權限 ---
startBtn.addEventListener('click', async () => {
    // 初始化 AudioContext
    await AudioSys.ctx.resume();
    startBtn.disabled = true;
    statusText.innerText = "請求相機權限...";

    const bgm = new Audio("music.mp3");
    bgm.loop = true;
    bgm.volume = 0.5;
    bgm.play().catch(err => {
        console.log("瀏覽器阻止自動播放，需要使用者互動:", err);
    });


    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: 'user' },
            audio: false
        });
        
        videoElement.srcObject = stream;
        videoElement.onloadedmetadata = () => {
            overlayCanvas.width = videoElement.videoWidth;
            overlayCanvas.height = videoElement.videoHeight;
            
            videoElement.play();
            statusText.innerText = "載入 AI 模型中...";
            detectLoop();
        };
    } catch (err) {
        console.error(err);
        statusText.innerText = "錯誤：相機無法啟動";
        startBtn.disabled = false;
    }
});

async function detectLoop() {
    if (videoElement.readyState >= 2) {
        await faceMesh.send({image: videoElement});
    }
    requestAnimationFrame(detectLoop);
}

function onResults(results) {
    if (!modelLoaded) { modelLoaded = true; startGame(); }

    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        
        // 遊戲游標用的座標 (鏡像後)
        nosePos.x = 1.0 - landmarks[1].x; 
        nosePos.y = landmarks[1].y;

        // 計算閉眼
        const leftEyeUpper = landmarks[159];
        const leftEyeLower = landmarks[145];
        const rightEyeUpper = landmarks[386];
        const rightEyeLower = landmarks[374];

        const leftEyeDist = Math.abs(leftEyeUpper.y - leftEyeLower.y);
        const rightEyeDist = Math.abs(rightEyeUpper.y - rightEyeLower.y);
        isEyesClosed = ((leftEyeDist + rightEyeDist) / 2) < EYE_CLOSED_THRESHOLD;

        // [修改] 在攝影機畫面上只畫鼻尖點 (Landmark 1)
        drawNoseDot(landmarks[1]);
    }
}

// [修改] 畫鼻尖點 (Cyan色)
function drawNoseDot(noseLandmark) {
    const w = overlayCanvas.width;
    const h = overlayCanvas.height;
    const x = noseLandmark.x * w;
    const y = noseLandmark.y * h;

    overlayCtx.fillStyle = "#00ffff"; // 青色
    overlayCtx.shadowBlur = 5;
    overlayCtx.shadowColor = "#00ffff";
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 6, 0, Math.PI * 2); // 半徑6
    overlayCtx.fill();
    overlayCtx.shadowBlur = 0;
}

function startGame() {
    if(isGameRunning) return;
    isGameRunning = true;
    startScreen.style.display = 'none';
    uiLayer.style.pointerEvents = 'none';
    hud.style.display = 'block';
    resizeCanvas();
    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
}

// --- 4. 遊戲主迴圈 ---
function gameLoop(timestamp) {
    if (!isGameRunning) return;

    const dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;

    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    // 更新游標位置
    cursor.x = nosePos.x * canvasElement.width;
    cursor.y = nosePos.y * canvasElement.height;

    // --- 蓄力邏輯 ---
    if (isEyesClosed) {
        blinkTimer += dt;
        if (blinkTimer > BLINK_FILTER_TIME) {
            if (!isCharging) {
                isCharging = true;
                AudioSys.startCharging(); 
                chargeBarContainer.style.display = 'block';
            }
            if (chargeTimer < FULL_CHARGE_TIME) {
                chargeTimer += dt;
                timeDilation = 0.05; // 時間變慢
            } else {
                if (!isFullyCharged) {
                    isFullyCharged = true;
                    AudioSys.playLockSound();
                }
            }
        }
    } else {
        if (isCharging) {
            // 開眼瞬間，若滿氣則斬擊
            if (isFullyCharged) performSlash();
            
            // 重置
            isCharging = false;
            isFullyCharged = false;
            chargeTimer = 0;
            blinkTimer = 0;
            timeDilation = 1.0; 
            AudioSys.stopCharging();
            chargeBarContainer.style.display = 'none';
        }
        blinkTimer = 0; 
    }

    // 更新蓄力條 UI
    const chargePct = Math.min((chargeTimer / FULL_CHARGE_TIME) * 100, 100);
    chargeBar.style.width = `${chargePct}%`;
    chargeBar.style.boxShadow = isFullyCharged ? "0 0 15px #fff" : "none";

    // 生成敵人
    if (!isCharging && timestamp - lastSpawnTime > SPAWN_RATE) {
        targets.push(new Target());
        lastSpawnTime = timestamp;
    }

    // 更新與繪製敵人
    for (let i = targets.length - 1; i >= 0; i--) {
        let t = targets[i];
        if (!isCharging) {
            // [修改] 判定距離增加 HIT_BUFFER，更容易瞄準
            const dist = Math.hypot(cursor.x - t.x, cursor.y - t.y);
            t.isLocked = dist < (t.radius + cursor.radius + HIT_BUFFER);
        }
        t.update();
        t.draw(canvasCtx);
        if (t.isDead) targets.splice(i, 1);
    }

    // 粒子碎片更新
    for (let i = particles.length - 1; i >= 0; i--) {
        particles[i].update();
        particles[i].draw(canvasCtx);
        if (particles[i].life <= 0) particles.splice(i, 1);
    }

    // 繪製遊戲游標
    drawCursor(canvasCtx, cursor.x, cursor.y);

    // 蓄力時的暗角效果
    if (isCharging) drawVignette(canvasCtx);
    
    requestAnimationFrame(gameLoop);
}

// --- 5. 類別定義 ---
class Target {
    constructor() {
        this.isBonus = Math.random() < 0.2; 
        if (this.isBonus) {
            this.text = FRUITS[Math.floor(Math.random() * FRUITS.length)];
            this.color = "#FF4081"; 
            this.points = 50;
        } else {
            this.text = LETTERS.charAt(Math.floor(Math.random() * LETTERS.length));
            this.color = `hsl(${Math.random() * 360}, 70%, 60%)`;
            this.points = 10;
        }

        // [修改] 基礎半徑加大 (原本約 25~75 -> 改為 45~95)
        this.radius = 45 + Math.random() * 50; 
        
        this.x = (canvasElement.width / 2) + (Math.random() - 0.5) * 600; 
        this.y = canvasElement.height + this.radius;
        this.vy = -(15 + Math.random() * 6);
        this.vx = this.isBonus ? (Math.random() - 0.5) * 14 : (Math.random() - 0.5) * 5;

        this.rotation = (Math.random() - 0.5) * 0.1;
        this.angle = 0;
        this.isLocked = false;
        this.isDead = false;
    }

    update() {
        this.x += this.vx * timeDilation;
        this.y += this.vy * timeDilation;
        this.vy += 0.25 * timeDilation; 
        this.angle += this.rotation * timeDilation;
        if (this.y > canvasElement.height + 200) this.isDead = true;
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // 被瞄準時的特效
        if (this.isLocked) {
            ctx.shadowBlur = 30;
            ctx.shadowColor = "#fff";
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.arc(0, 0, this.radius + 10, 0, Math.PI * 2);
            ctx.stroke();
        }

        if (this.isBonus) {
            // 水果字體大小隨半徑調整
            ctx.font = `${this.radius * 2}px serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(this.text, 0, 5);
        } else {
            ctx.fillStyle = "rgba(40,40,40,0.8)";
            ctx.shadowBlur = 0; 
            ctx.beginPath(); ctx.arc(0,0,this.radius,0,Math.PI*2); ctx.fill();
            
            ctx.strokeStyle = this.color;
            ctx.lineWidth = 4;
            ctx.stroke();
            
            ctx.fillStyle = "#fff";
            // 字母大小隨半徑調整
            ctx.font = `bold ${this.radius * 1.2}px Arial`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(this.text, 0, 4);
        }
        ctx.restore();
    }
}

// 產生碎片
function createExplosion(target) {
    const particleCount = 12;
    for (let i = 0; i < particleCount; i++) {
        particles.push(new Particle(
            target.x, target.y, target.text, target.color, target.radius, target.isBonus
        ));
    }
}

class Particle {
    constructor(x, y, text, color, size, isEmoji) {
        this.x = x; this.y = y;
        this.text = text;       
        this.color = color;
        this.isEmoji = isEmoji; 
        
        this.size = size * (0.3 + Math.random() * 0.3);
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 8 + 3;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
        this.rotation = Math.random() * Math.PI * 2;
        this.vRot = (Math.random() - 0.5) * 0.4;
        this.life = 1.0; 
        this.decay = 0.012; 
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.vx *= 0.96; 
        this.vy *= 0.96;
        this.vy += 0.15; 
        this.rotation += this.vRot;
        this.life -= this.decay;
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.rotation);
        ctx.globalAlpha = this.life;
        
        if (this.isEmoji) {
            ctx.font = `${this.size}px serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(this.text, 0, 0);
        } else {
            ctx.fillStyle = this.color;
            ctx.font = `bold ${this.size}px Arial`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(this.text, 0, 0);
        }
        ctx.restore();
    }
}

// --- 6. 音效 ---
const AudioSys = {
    ctx: new (window.AudioContext || window.webkitAudioContext)(),
    oscillators: [], gainNode: null,

    startCharging: function() {
        if (this.gainNode) return;
        this.gainNode = this.ctx.createGain();
        this.gainNode.gain.value = 0; 
        this.gainNode.connect(this.ctx.destination);
        const now = this.ctx.currentTime;
        const freqs = [220.00, 277.18, 329.63, 440.00]; 
        freqs.forEach(f => {
            const o = this.ctx.createOscillator();
            o.type = 'sine'; o.frequency.value = f;
            o.connect(this.gainNode); o.start(now);
            this.oscillators.push(o);
        });
        this.gainNode.gain.setTargetAtTime(0.2, now, FULL_CHARGE_TIME/3); 
    },

    stopCharging: function() {
        if (!this.gainNode) return;
        const now = this.ctx.currentTime;
        this.gainNode.gain.setTargetAtTime(0, now, 0.1);
        setTimeout(() => {
            this.oscillators.forEach(o => {try{o.stop();o.disconnect();}catch(e){}});
            this.oscillators=[]; this.gainNode.disconnect(); this.gainNode=null;
        }, 150);
    },

    playLockSound: function() {
        const osc = this.ctx.createOscillator(); const g = this.ctx.createGain();
        osc.type = 'sine'; 
        osc.frequency.setValueAtTime(1200, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1500, this.ctx.currentTime+0.1);
        g.gain.setValueAtTime(0.4, this.ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime+0.5);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime+0.6);
    },

    playSlash: function() {
        const b = this.ctx.createBuffer(1, this.ctx.sampleRate*0.3, this.ctx.sampleRate);
        const d = b.getChannelData(0);
        for(let i=0; i<d.length; i++) d[i] = (Math.random()*2-1);
        const s = this.ctx.createBufferSource(); s.buffer = b;
        const g = this.ctx.createGain();
        const f = this.ctx.createBiquadFilter(); f.type='lowpass';
        f.frequency.setValueAtTime(1200, this.ctx.currentTime);
        f.frequency.linearRampToValueAtTime(100, this.ctx.currentTime+0.25);
        g.gain.setValueAtTime(0.5, this.ctx.currentTime);
        g.gain.linearRampToValueAtTime(0, this.ctx.currentTime+0.3);
        s.connect(f); f.connect(g); g.connect(this.ctx.destination); s.start();
    }
};

function performSlash() {
    AudioSys.playSlash();
    let hits = 0;
    // 檢查所有目標
    for (let i = targets.length - 1; i >= 0; i--) {
        if (targets[i].isLocked) {
            targets[i].isDead = true;
            score += targets[i].points;
            createExplosion(targets[i]);
            hits++;
        }
    }
    if (hits > 0) scoreEl.innerText = score;
}

function drawCursor(ctx, x, y) {
    ctx.shadowBlur = isCharging ? 20 : 0;
    ctx.shadowColor = "#ff4081";
    ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI*2);
    ctx.fillStyle = isCharging ? "#ff4081" : "#00e676"; ctx.fill();
    
    // 外圈
    ctx.beginPath(); ctx.arc(x, y, 20, 0, Math.PI*2);
    ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 3; ctx.stroke();
    
    // 如果正在蓄力，畫一個更大的範圍指示圈，表示爆炸半徑
    if (isCharging) {
        ctx.beginPath();
        ctx.arc(x, y, 100, 0, Math.PI*2); // 示意有效範圍
        ctx.strokeStyle = "rgba(255, 64, 129, 0.3)";
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    ctx.shadowBlur = 0;
}

function drawVignette(ctx) {
    const g = ctx.createRadialGradient(canvasElement.width/2, canvasElement.height/2, canvasElement.height/3, canvasElement.width/2, canvasElement.height/2, canvasElement.height);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.8)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvasElement.width, canvasElement.height);
}

function resizeCanvas() {
    canvasElement.width = window.innerWidth;
    canvasElement.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();