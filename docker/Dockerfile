# ABOUTME: The image a self-run's Docker sandbox starts from: AlmaLinux 9.8, pinned by digest,
# with the packages the E2B template installs, so the open sandbox assets run the same as on
# the hosted providers. The digest is the multi-arch index, so one file builds linux/amd64 and
# linux/arm64; build for the host's own platform (setup.sh picks its downloads to match), e.g.
# `docker build --platform linux/arm64 -t agentpicks-sandbox:el9 packages/agentpicks/docker`.
FROM almalinux:9.8@sha256:245f8aab832fe800aa42bdab5fad75ebbd8e0b4c9f24820a83c638b177857ae2

# Keep this list equal to AGENT_PICKS_E2B_PACKAGES in
# packages/agent-picks/src/sandbox/e2b-template.ts; e2b-template.spec.ts checks it.
RUN dnf install -y -q \
      bind-utils \
      bzip2 \
      ca-certificates \
      findutils \
      gawk \
      git \
      gzip \
      iputils \
      less \
      libicu \
      libjpeg-turbo \
      libpng \
      libyaml \
      ncurses \
      openssh-clients \
      openssl \
      perl-interpreter \
      procps-ng \
      python3 \
      sqlite-libs \
      sudo \
      tar \
      tzdata \
      unzip \
      util-linux \
      which \
      whois \
      xz \
      zstd \
    && dnf clean all
