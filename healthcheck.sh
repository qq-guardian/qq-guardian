#!/bin/sh
set -eu
node -e "fetch('http://127.0.0.1:' + (process.env.QQ_GUARDIAN_HTTP_PORT || 6099) + '/plugin/napcat-plugin-qq-guardian/page/guardian').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
