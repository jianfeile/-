#!/usr/bin/env python3
"""Records the clips listed by tools/audio.mjs with Piper (open-source speech synthesis) as small mp3 files.

    python -m venv venv && venv/bin/pip install piper-tts lameenc
    venv/bin/python tools/audio_gen.py clips.json site/audio fr_FR-siwis-medium.onnx [worker] [workers]

The voice file (and its .json) come from https://huggingface.co/rhasspy/piper-voices (fr/fr_FR/siwis/medium).
The siwis voice is trained on the SIWIS French Speech Synthesis Database, licence CC BY 4.0: credit it where the
recordings are used. Files are written to <out>/<first two letters>/<name>.mp3; existing files are kept, so the
script can be stopped and started again, and several workers can run side by side (worker = 0 .. workers-1).
"""
import io, json, os, sys, wave

def main():
    clips = json.load(open(sys.argv[1], encoding='utf8'))
    out, model = sys.argv[2], sys.argv[3]
    worker = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    workers = int(sys.argv[5]) if len(sys.argv) > 5 else 1
    from piper import PiperVoice
    import lameenc
    voice = PiperVoice.load(model)
    done = 0
    for i, c in enumerate(clips):
        if i % workers != worker:
            continue
        path = os.path.join(out, c['k'][:2], c['k'] + '.mp3')
        if os.path.exists(path) and os.path.getsize(path) > 300:
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as w:
            voice.synthesize_wav(c['t'], w)
        buf.seek(0)
        with wave.open(buf, 'rb') as r:
            rate, ch, pcm = r.getframerate(), r.getnchannels(), r.readframes(r.getnframes())
        enc = lameenc.Encoder()
        enc.set_bit_rate(24); enc.set_in_sample_rate(rate); enc.set_channels(ch); enc.set_quality(2)
        data = enc.encode(pcm) + enc.flush()
        tmp = path + '.part'
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, path)
        done += 1
        if done % 200 == 0:
            print('worker', worker, 'recorded', done, flush=True)
    print('worker', worker, 'finished, recorded', done, flush=True)

if __name__ == '__main__':
    main()
