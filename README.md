# docker-golang-nightly
Docker image packaging for golang nightly builds

Public automated build of image on Dockerhub: [golang-nightly](https://hub.docker.com/r/strarsis/golang-nightly/)


Usage
-----
One can conveniently build/development with this image.
Building from an existing github repository into cwd of host system:
````
$ docker run --rm -v $(pwd):/root/src strarsis/golang-nightly:build-1.6beta1-nightly-e2093cdeef8dcf0303ce3d8e79247c71ed53507d /bin/sh -c \
'cd /root/src && export GOPATH=$(pwd) && go get -u github.com/user/repo
````
