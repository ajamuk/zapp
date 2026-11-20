"""Transcribe una nota de voz con faster-whisper (modelo local, sin red). Uso: python transcribir.py <audio> [idioma]
Imprime el texto por stdout. Variables: TRANSCRIPTOR_MODELOS (carpeta del modelo), TRANSCRIPTOR_MODELO (small)."""
import os
import sys

from faster_whisper import WhisperModel

modelo = WhisperModel(
    os.environ.get('TRANSCRIPTOR_MODELO', 'small'), device='cpu', compute_type='int8',
    download_root=os.environ.get('TRANSCRIPTOR_MODELOS') or None, local_files_only=True, cpu_threads=4,
)
segmentos, _ = modelo.transcribe(sys.argv[1], language=sys.argv[2] if len(sys.argv) > 2 else 'es', beam_size=5, vad_filter=True)
print(' '.join(s.text.strip() for s in segmentos).strip())
