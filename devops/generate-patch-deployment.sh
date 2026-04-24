#!/bin/bash

ARG_FQN=$1
ARG_HASH=$2
if [ -z $ARG_FQN ] || [ -z $ARG_HASH ]
then
  echo "Please supply both an image fully qualified name and a commit hash. Exiting."
  exit 1
fi

echo "[{\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/image\", \"value\":\"$ARG_FQN:$ARG_HASH\"}]"