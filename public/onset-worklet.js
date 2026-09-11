//#region src/dsp-core.js
/**
* The onset detector, as pure functions.
*
* Deliberately free of AudioWorklet globals so the exact same code can run in the
* worklet, in the offline analyser against real recordings, and in tests. If the
* detector that runs in the app is not literally the one that was tuned against the
* recordings, the tuning means nothing.
*
* Approach: a bandpass filterbank with fast and slow envelope followers, which is what
* hardware drum triggers do. An FFT would impose hop-size time quantisation and half a
* window of group delay; here the time resolution is the sample rate, and the group
* delay stays well under a millisecond.
*
* Each band is a CASCADE of biquads, not one. This matters more than it looks. A single
* biquad rolls off at only 6 dB/octave, so the 900 Hz metronome click sat barely 13 dB
* down inside the 2.5 kHz band and triggered the detector as readily as a real hit —
* measured on the actual pad, one biquad per band gave 8 false triggers from 10 clicks.
* Cascading three gets 18 dB/octave and pushes the click far enough down to disappear.
*
* The detection function is a RATIO, (fast - slow) / slow, not a difference. That makes
* it amplitude-normalised, so the iPad's auto-gain (which cannot be turned off) and a
* child hitting at wildly different volumes both stop mattering.
*/
/** RBJ cookbook bandpass, constant 0 dB peak gain. */
function bandpassCoeffs(fc, Q, rate) {
	const w0 = 2 * Math.PI * fc / rate;
	const alpha = Math.sin(w0) / (2 * Q);
	const a0 = 1 + alpha;
	return {
		b0: alpha / a0,
		b1: 0,
		b2: -alpha / a0,
		a1: -2 * Math.cos(w0) / a0,
		a2: (1 - alpha) / a0
	};
}
/** One-pole smoothing coefficient for a given time constant. */
var poleFor = (tauMs, rate) => Math.exp(-1 / (tauMs / 1e3 * rate));
var OnsetDetector = class {
	/**
	* @param {number} rate sample rate
	* @param {object} cfg  see DETECTOR in config.js
	*/
	constructor(rate, cfg) {
		this.rate = rate;
		this.cfg = cfg;
		this.bands = cfg.bands.filter((f) => f < rate * .45);
		this.n = this.bands.length;
		this.needed = Math.min(cfg.bandsNeeded, this.n);
		this.stages = cfg.stages || 1;
		this.co = this.bands.map((f) => bandpassCoeffs(f, cfg.q, rate));
		const w = this.n * this.stages;
		this.x1 = new Float64Array(w);
		this.x2 = new Float64Array(w);
		this.y1 = new Float64Array(w);
		this.y2 = new Float64Array(w);
		this.fast = new Float64Array(this.n);
		this.slow = new Float64Array(this.n);
		this.floor = new Float64Array(this.n).fill(1e-4);
		this.hot = new Int32Array(this.n).fill(-1e9);
		this.aFast = poleFor(cfg.fastTauMs, rate);
		this.aSlow = poleFor(cfg.slowTauMs, rate);
		this.floorRise = Math.pow(10, 6 / 20 / rate);
		this.enabled = new Uint8Array(this.n).fill(1);
		this.enabledCount = this.n;
		this.minLevel = 0;
		this.agreeSamples = Math.max(1, Math.round(cfg.agreementMs / 1e3 * rate));
		this.frame = 0;
		this.lastOnset = -1e9;
		this.lastPeak = 0;
		this.histLen = Math.max(64, Math.round(.03 * rate));
		this.hist = new Float64Array(this.histLen);
		this.histPos = 0;
		this.refractorySamples = Math.round(cfg.refractoryMs / 1e3 * rate);
		this.levelWindow = Math.round(.008 * rate);
		this.held = null;
	}
	/** Refractory can be tightened per exercise; see refractoryForSpacing(). */
	setRefractoryMs(ms) {
		this.refractorySamples = Math.round(ms / 1e3 * this.rate);
	}
	/**
	* Turn bands on and off as the app learns which ones separate her hits from the
	* bleed on THIS device. Never leaves fewer than two enabled: a detector down to one
	* band has no agreement test left and will fire on anything.
	*/
	setEnabledBands(mask) {
		let on = 0;
		for (let b = 0; b < this.n; b++) {
			this.enabled[b] = mask[b] ? 1 : 0;
			on += this.enabled[b];
		}
		if (on < 1) {
			this.enabled.fill(1);
			on = this.n;
		}
		this.enabledCount = on;
	}
	setMinLevel(v) {
		this.minLevel = Math.max(0, v || 0);
	}
	/**
	* How many enabled bands must agree.
	*
	* This is the strongest thing separating a stick from the metronome: a stick excites
	* every band at once, speaker distortion lights up two or three. Kept as a high
	* fraction, and never below three, so the rule cannot be hollowed out by disabling
	* bands.
	*/
	get needAgree() {
		const f = this.cfg.agreeFraction || .7;
		return Math.max(Math.min(3, this.enabledCount), Math.min(this.enabledCount, Math.round(this.enabledCount * f)));
	}
	/**
	* @param {Float32Array} block
	* @param {number} startFrame absolute frame index of block[0]
	* @returns {Array<{frame:number, strength:number, bands:number, riseMs:number}>}
	*/
	process(block, startFrame = this.frame) {
		this.frame = startFrame;
		const out = [];
		const { cfg } = this;
		for (let i = 0; i < block.length; i++) {
			const x = block[i];
			let sum = 0;
			let agree = 0;
			for (let b = 0; b < this.n; b++) {
				const c = this.co[b];
				let y = x;
				for (let st = 0; st < this.stages; st++) {
					const k = b * this.stages + st;
					const inp = y;
					y = c.b0 * inp + c.b1 * this.x1[k] + c.b2 * this.x2[k] - c.a1 * this.y1[k] - c.a2 * this.y2[k];
					this.x2[k] = this.x1[k];
					this.x1[k] = inp;
					this.y2[k] = this.y1[k];
					this.y1[k] = y;
				}
				const mag = Math.abs(y);
				this.fast[b] = this.aFast * this.fast[b] + (1 - this.aFast) * mag;
				this.slow[b] = this.aSlow * this.slow[b] + (1 - this.aSlow) * mag;
				if (this.fast[b] < this.floor[b]) this.floor[b] = this.fast[b];
				else this.floor[b] *= this.floorRise;
				if (!this.enabled[b]) continue;
				sum += this.fast[b];
				const overSlow = this.fast[b] > cfg.triggerOverSlow * this.slow[b];
				const overFloor = this.fast[b] > cfg.triggerOverFloor * this.floor[b];
				if (overSlow && overFloor) this.hot[b] = this.frame;
				if (this.frame - this.hot[b] <= this.agreeSamples) agree++;
			}
			this.hist[this.histPos] = sum;
			this.histPos = (this.histPos + 1) % this.histLen;
			if (agree >= this.needAgree && sum > this.minLevel && this.frame - this.lastOnset >= this.refractorySamples) {
				const quieterThanLast = this.lastPeak > 0 ? 20 * Math.log10(sum / this.lastPeak) : 0;
				if (!(this.frame - this.lastOnset < cfg.bounceRejectMs / 1e3 * this.rate && quieterThanLast <= -cfg.bounceRejectDb)) {
					if (this.held) out.push(this._release());
					this.held = {
						frame: this.frame,
						strength: sum,
						bands: agree,
						levels: Array.from(this.fast),
						peakFrame: this.frame,
						until: this.frame + this.levelWindow
					};
					this.lastOnset = this.frame;
					this.lastPeak = sum;
				}
			}
			if (this.held) {
				for (let b = 0; b < this.n; b++) if (this.fast[b] > this.held.levels[b]) this.held.levels[b] = this.fast[b];
				if (sum > this.held.strength) {
					this.held.strength = sum;
					this.held.peakFrame = this.frame;
				}
				if (this.frame >= this.held.until) {
					const rel = this._release();
					if (rel) out.push(rel);
				}
			}
			this.frame++;
		}
		return out;
	}
	_release() {
		const h = this.held;
		this.held = null;
		this.lastPeak = h.strength;
		return {
			frame: h.frame,
			strength: h.strength,
			bands: h.bands,
			riseMs: h.riseMs,
			levels: h.levels
		};
	}
	/** Current per-band envelope, for sampling the bleed at a known moment. */
	snapshot() {
		return Array.from(this.fast);
	}
	/** How long ago the summed envelope was at 20% of its current value, in ms. */
	_riseTime(now) {
		if (now <= 0) return 1e6;
		const target = now * .2;
		for (let k = 1; k < this.histLen; k++) {
			const idx = (this.histPos - 1 - k + this.histLen * 2) % this.histLen;
			if (this.hist[idx] <= target) return k / this.rate * 1e3;
		}
		return this.histLen / this.rate * 1e3;
	}
};
/**
* Listens for the app's own metronome click coming back through the microphone.
*
* This is the piece that makes latency calibration continuous and safe. The click is a
* signal we generated ourselves, arriving every beat, and it has NOTHING to do with how
* the child is playing — so the delay between scheduling it and hearing it can be
* re-measured forever without ever contaminating her score.
*
* The distinction matters enormously. Adapting the latency constant from HER hits would
* centre her errors on zero by construction: a child who consistently rushes would be
* told she is perfect. Adapting it from the click cannot do that.
*
* Discriminating a click from a drum hit is easy because they are opposites: the click
* is sustained narrowband energy with almost nothing up high, a stick is a broadband
* impulse. Requiring a high narrow-to-bright ratio separates them cleanly.
*/
var ClickProbe = class {
	constructor(rate, { freq = 900, q = 8, stages = 2, brightHz = 5e3, minRatio = 4, minOverFloor = 6 } = {}) {
		this.rate = rate;
		this.minRatio = minRatio;
		this.minOverFloor = minOverFloor;
		this.stages = stages;
		this.narrowCo = bandpassCoeffs(freq, q, rate);
		this.brightCo = bandpassCoeffs(Math.min(brightHz, rate * .45), 2, rate);
		this.nx1 = new Float64Array(stages);
		this.nx2 = new Float64Array(stages);
		this.ny1 = new Float64Array(stages);
		this.ny2 = new Float64Array(stages);
		this.bx1 = 0;
		this.bx2 = 0;
		this.by1 = 0;
		this.by2 = 0;
		this.aEnv = poleFor(4, rate);
		this.nEnv = 0;
		this.bEnv = 0;
		this.floor = 1e-5;
		this.floorRise = Math.pow(10, 6 / 20 / rate);
		this.rising = false;
		this.peak = 0;
		this.peakFrame = 0;
		this.frame = 0;
		this.lastEmit = -1e9;
		this.minGap = Math.round(.15 * rate);
	}
	/**
	* @returns {Array<{frame:number, level:number, ratio:number}>} peaks of the click
	*   burst. The peak sits at the CENTRE of the burst, so a caller comparing against a
	*   scheduled time should subtract half the click duration.
	*/
	process(block, startFrame = this.frame) {
		this.frame = startFrame;
		const out = [];
		for (let i = 0; i < block.length; i++) {
			const x = block[i];
			let n = x;
			for (let s = 0; s < this.stages; s++) {
				const c = this.narrowCo;
				const inp = n;
				n = c.b0 * inp + c.b2 * this.nx2[s] - c.a1 * this.ny1[s] - c.a2 * this.ny2[s];
				this.nx2[s] = this.nx1[s];
				this.nx1[s] = inp;
				this.ny2[s] = this.ny1[s];
				this.ny1[s] = n;
			}
			const bc = this.brightCo;
			const b = bc.b0 * x + bc.b2 * this.bx2 - bc.a1 * this.by1 - bc.a2 * this.by2;
			this.bx2 = this.bx1;
			this.bx1 = x;
			this.by2 = this.by1;
			this.by1 = b;
			this.nEnv = this.aEnv * this.nEnv + (1 - this.aEnv) * Math.abs(n);
			this.bEnv = this.aEnv * this.bEnv + (1 - this.aEnv) * Math.abs(b);
			if (this.nEnv < this.floor) this.floor = this.nEnv;
			else this.floor *= this.floorRise;
			if (this.nEnv > this.floor * this.minOverFloor && this.nEnv > this.peak) {
				this.peak = this.nEnv;
				this.peakFrame = this.frame;
				this.peakBright = this.bEnv;
				this.rising = true;
			} else if (this.rising && this.nEnv < this.peak * .5) {
				const ratio = this.peak / (this.peakBright + 1e-12);
				if (ratio >= this.minRatio && this.peakFrame - this.lastEmit > this.minGap) {
					out.push({
						frame: this.peakFrame,
						level: this.peak,
						ratio
					});
					this.lastEmit = this.peakFrame;
				}
				this.rising = false;
				this.peak = 0;
			}
			this.frame++;
		}
		return out;
	}
};
//#endregion
//#region src/worklets/onset-processor.js
/**
* The audio worklet: onset detection and click probing on the render thread.
*
* It runs the very same OnsetDetector and ClickProbe that were tuned against the Phase 0
* recordings — bundled in by tools/build-worklet.mjs rather than copied, so the two can
* never drift apart.
*
* Timestamps are computed here as (currentFrame + i) / sampleRate, which is already in
* AudioContext time. They travel inside the message. The classic bug is stamping a hit
* when the main thread happens to receive the message; that would add tens of
* milliseconds of random jitter and is exactly what this avoids.
*/
var DrumOnsetProcessor = class extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const o = options.processorOptions || {};
		this.det = new OnsetDetector(sampleRate, o.detector);
		this.probe = new ClickProbe(sampleRate, o.click || {});
		this.listening = true;
		this.probing = true;
		this.recSeconds = o.recordSeconds || 0;
		if (this.recSeconds > 0) {
			this.rec = new Float32Array(Math.round(sampleRate * this.recSeconds));
			this.recPos = 0;
			this.recWrapped = false;
		}
		this.meterPeak = 0;
		this.meterCount = 0;
		this.meterEvery = Math.round(sampleRate / 20);
		this.port.onmessage = (e) => {
			const m = e.data;
			if (m.type === "refractory") this.det.setRefractoryMs(m.ms);
			else if (m.type === "listen") this.listening = m.on;
			else if (m.type === "probe") this.probing = m.on;
			else if (m.type === "dump") this._dump();
			else if (m.type === "tune") {
				if (m.mask) this.det.setEnabledBands(m.mask);
				if (typeof m.minLevel === "number") this.det.setMinLevel(m.minLevel);
			}
		};
		this.port.postMessage({
			type: "ready",
			sampleRate
		});
	}
	/** Hand the recorded window to the main thread, oldest sample first. */
	_dump() {
		if (!this.rec) return this.port.postMessage({
			type: "audio",
			empty: true
		});
		const n = this.recWrapped ? this.rec.length : this.recPos;
		const out = new Float32Array(n);
		if (this.recWrapped) {
			const tail = this.rec.length - this.recPos;
			out.set(this.rec.subarray(this.recPos), 0);
			out.set(this.rec.subarray(0, this.recPos), tail);
		} else out.set(this.rec.subarray(0, n));
		const startFrame = currentFrame - n;
		this.port.postMessage({
			type: "audio",
			startFrame,
			sampleRate,
			pcm: out
		}, [out.buffer]);
	}
	process(inputs) {
		const input = inputs[0];
		const ch = input && input.length ? input[0] : null;
		if (!ch) {
			this.silentQuanta = (this.silentQuanta || 0) + 1;
			if (this.silentQuanta % 200 === 0) this.port.postMessage({ type: "noInput" });
			return true;
		}
		this.silentQuanta = 0;
		if (this.listening) {
			const hits = this.det.process(ch, currentFrame);
			for (const h of hits) this.port.postMessage({
				type: "hit",
				time: h.frame / sampleRate,
				strength: h.strength,
				bands: h.bands,
				levels: h.levels
			});
		}
		if (this.probing) {
			const clicks = this.probe.process(ch, currentFrame);
			for (const c of clicks) this.port.postMessage({
				type: "click",
				time: c.frame / sampleRate,
				level: c.level,
				levels: this.det.snapshot()
			});
		}
		if (this.rec) for (let i = 0; i < ch.length; i++) {
			this.rec[this.recPos] = ch[i];
			if (++this.recPos >= this.rec.length) {
				this.recPos = 0;
				this.recWrapped = true;
			}
		}
		for (let i = 0; i < ch.length; i++) {
			const a = Math.abs(ch[i]);
			if (a > this.meterPeak) this.meterPeak = a;
		}
		this.meterCount += ch.length;
		if (this.meterCount >= this.meterEvery) {
			this.port.postMessage({
				type: "level",
				peak: this.meterPeak,
				levels: this.det.snapshot()
			});
			this.recSeconds = o.recordSeconds || 0;
			if (this.recSeconds > 0) {
				this.rec = new Float32Array(Math.round(sampleRate * this.recSeconds));
				this.recPos = 0;
				this.recWrapped = false;
			}
			this.meterPeak = 0;
			this.meterCount = 0;
		}
		return true;
	}
};
registerProcessor("drum-onset", DrumOnsetProcessor);
//#endregion
