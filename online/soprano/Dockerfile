# Soprano text-to-speech (github.com/ekwek1/soprano) as a small HTTP service for AI-DnD Online.
# It needs about 1.2 GB of memory. Point the game at it with SOPRANO_URL=http://<host>:<port>.
FROM python:3.11-slim
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
 && pip install --no-cache-dir soprano-tts uvicorn
# Download the model while building so the service starts quickly.
RUN python -c "from soprano.tts import SopranoTTS; SopranoTTS(cache_size_mb=100)"
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn soprano.server:app --host 0.0.0.0 --port ${PORT}"]
