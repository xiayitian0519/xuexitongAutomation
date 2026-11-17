"""Local English listening ASR. No microphone, upload, account, or implicit download."""
import argparse
import json
import sys
import time
from pathlib import Path


def peak_memory():
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize",
                "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        current = ctypes.windll.kernel32.GetCurrentProcess
        current.restype = wintypes.HANDLE
        query = ctypes.windll.psapi.GetProcessMemoryInfo
        query.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        if query(current(), ctypes.byref(counters), counters.cb):
            return counters.PeakWorkingSetSize
    return None


def main():
    started = time.perf_counter()
    cpu_started = time.process_time()
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--dependencies")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--start-seconds", type=float)
    parser.add_argument("--end-seconds", type=float)
    args = parser.parse_args()
    if args.dependencies:
        sys.path.insert(0, str(Path(args.dependencies).resolve()))
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    imported_at = time.perf_counter()
    if not 1 <= args.threads <= 16:
        raise ValueError("Invalid thread count")
    model_path = Path(args.model).resolve()
    if not (model_path / "model.bin").is_file() or (model_path / "model.bin").stat().st_size == 0:
        raise ValueError("Local model is missing or empty")
    audio = decode_audio(args.input, sampling_rate=16000)
    decoded_at = time.perf_counter()
    source_duration = len(audio) / 16000
    if not 0 < source_duration <= 20 * 60:
        raise ValueError("Audio duration is outside practice limits")
    start = 0.0 if args.start_seconds is None else args.start_seconds
    end = source_duration if args.end_seconds is None else args.end_seconds
    if not 0 <= start < end <= source_duration + 0.05:
        raise ValueError("Invalid audio range")
    audio = audio[int(start * 16000):min(len(audio), int(end * 16000))]
    model = WhisperModel(str(model_path), device="cpu", compute_type="int8", local_files_only=True,
                         cpu_threads=args.threads, num_workers=1)
    model_loaded_at = time.perf_counter()
    segments, info = model.transcribe(audio, language="en", beam_size=5,
                                      word_timestamps=True, condition_on_previous_text=False)
    if not 0 < info.duration <= 20 * 60:
        raise ValueError("Audio duration is outside practice limits")
    rows = []
    for segment in segments:
        rows.append({"start": segment.start, "end": segment.end, "text": segment.text.strip(),
                     "avgLogprob": segment.avg_logprob, "noSpeechProb": segment.no_speech_prob,
                     "words": [{"start": word.start, "end": word.end, "text": word.word,
                                "probability": word.probability} for word in segment.words or []]})
    print(json.dumps({"schemaVersion": 1, "engine": "faster-whisper", "language": info.language,
                      "duration": info.duration, "sourceDuration": source_duration,
                      "offsetSeconds": start, "segments": rows,
                      "runtime": {"wallMs": round((time.perf_counter() - started) * 1000),
                                  "cpuMs": round((time.process_time() - cpu_started) * 1000),
                                  "importMs": round((imported_at - started) * 1000),
                                  "decodeMs": round((decoded_at - imported_at) * 1000),
                                  "modelLoadMs": round((model_loaded_at - decoded_at) * 1000),
                                  "recognitionMs": round((time.perf_counter() - model_loaded_at) * 1000),
                                  "peakMemoryBytes": peak_memory()}}, ensure_ascii=True, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not echo source URLs, model prompts or private file contents.
        print(json.dumps({"error": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
