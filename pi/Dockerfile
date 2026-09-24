# Control-plane image: the bus monitor UI plus everything it starts from the page —
# the model-free prod emulator (Node) and the Faker seeder (Python, db/seed.py).
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

COPY pi/package.json pi/package-lock.json pi/
RUN cd pi && npm ci --omit=dev

COPY db db
COPY pi pi

WORKDIR /app/pi
CMD ["node", "ui/server.mjs"]
