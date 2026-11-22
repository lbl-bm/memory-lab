import {verifySourceBuild} from './build-source-capture.mjs';
const [manifestPath, manifestSha256, buildId] = process.argv.slice(2);
const result = await verifySourceBuild(manifestPath, {manifestSha256, buildId});
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'verified-consistency') process.exitCode = 1;
