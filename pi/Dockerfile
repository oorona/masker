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

ENV HOME=/home/node
WORKDIR /app/pi
CMD ["node", "ui/server.mjs"]
