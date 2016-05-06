# latest possible stable go for bootstrapping new go (or just ":latest")
FROM golang:latest

# SHA of commit to build
ENV GOLANG_BUILD_SHA    a633d766d1763f4f4648e423c4e8a8635b183d03
# Last stable version prior this commit
ENV GOLANG_BASE_VERSION 1.6.2

ENV GOLANG_BUILD_VERSION $GOLANG_BASE_VERSION-nightly-$GOLANG_BUILD_SHA


# gcc for cgo
RUN apt-get update && apt-get install -y --no-install-recommends \
		g++ \
		gcc \
		libc6-dev \
		make \
	&& rm -rf /var/lib/apt/lists/*


ENV GOLANG_DOWNLOAD_URL  https://github.com/golang/go/archive/$GOLANG_BUILD_SHA.tar.gz
ENV GOSRC /usr/local/go-$GOLANG_BUILD_SHA

ENV GOROOT $GOSRC
ENV GOPATH /go
ENV GOROOT_BOOTSTRAP /usr/local/go

ENV GOBUILD $GOSRC/src


RUN curl -fsSL "$GOLANG_DOWNLOAD_URL" \
	| tar -C /usr/local -xz


RUN echo $GOLANG_BUILD_VERSION > "$GOROOT/VERSION"

WORKDIR $GOBUILD
RUN ./make.bash


# let new built go take precendence over old go used for bootstrapping it
ENV PATH=$GOSRC/bin:$PATH

