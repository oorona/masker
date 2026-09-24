# Control-plane image: the bus monitor UI plus everything it starts from the page —
# the real Pi agents (pi installed globally; login persisted in the /home/node/.pi
# volume), the model-free prod emulator (Node) and the Faker seeder (Python).
# Build context is the REPO ROOT (see docker-compose.yml: build.context ".").
# Node 22.18+ strips TypeScript types natively, so pi/lib/*.ts import without a build.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production PIP_ROOT_USER_ACTION=ignore

COPY db/requirements.txt db/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r db/requirements.txt

# Pi coding agent, pinned; keep in step with the workstation install.
ARG PI_VERSION=0.87.1
RUN npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@${PI_VERSION} \
 && mkdir -p /home/node/.pi/agent && chown -R node:node /home/node

COPY pi/package.json pi/package-lock.json pi/
RUN cd pi && npm ci --omit=dev

COPY db db
COPY pi pi

# Pi must write a lock next to each agent's project settings (.pi/settings.json.lock),
# and the rootfs is read-only at runtime. Keep pristine copies of the two .pi dirs and
# let the entrypoint restore them into the tmpfs mounts compose puts at those paths.
RUN mkdir -p /opt/masker-agents \
 && cp -r pi/prod/.pi /opt/masker-agents/prod.pi \
 && cp -r pi/test/.pi /opt/masker-agents/test.pi \
 && printf '#!/bin/sh\nset -e\nfor a in prod test; do cp -r /opt/masker-agents/$a.pi/. /app/pi/$a/.pi/ 2>/dev/null || true; done\nexec "$@"\n' > /usr/local/bin/masker-entrypoint \
 && chmod +x /usr/local/bin/masker-entrypoint

ENV HOME=/home/node
WORKDIR /app/pi
ENTRYPOINT ["masker-entrypoint"]
CMD ["node", "ui/server.mjs"]
