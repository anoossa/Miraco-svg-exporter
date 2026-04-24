#!/bin/bash

ARG_ACTION=$1
ARG_KEY=$2
ARG_VALUE=$3
FILENAME=devops/secrets.txt

# Check for the action
if [ -z $ARG_ACTION ]
then
  echo "Please supply an action: 'save'"
  exit 1
fi

# Save a key-value pair
if [ $ARG_ACTION == 'save' ]
then
  if [ -z $ARG_KEY ] || [ -z $ARG_VALUE ]
  then
    echo "Please supply a key and a value."
    exit 1
  else
    echo "Saving key: '${ARG_KEY}'..."
    echo "export ${ARG_KEY}=${ARG_VALUE}" >> $FILENAME
    echo "Saved."
  fi
fi