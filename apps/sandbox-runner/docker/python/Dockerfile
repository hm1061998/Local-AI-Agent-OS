FROM python:3.13.5-alpine
RUN addgroup -S skill && adduser -S -G skill -h /nonexistent skill
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /skill
COPY --chown=skill:skill apps/sandbox-runner/docker/python/runner.py /runner/runner.py
USER skill
ENTRYPOINT ["python","-I","/runner/runner.py"]
