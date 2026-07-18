FROM node:22.22.0-alpine
RUN addgroup -S skill && adduser -S -G skill -h /nonexistent skill
WORKDIR /skill
COPY --chown=skill:skill apps/sandbox-runner/docker/node/runner.js /runner/runner.js
USER skill
ENTRYPOINT ["node","/runner/runner.js"]
