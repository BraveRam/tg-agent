FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv curl git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
ENV PIP_BREAK_SYSTEM_PACKAGES=1
