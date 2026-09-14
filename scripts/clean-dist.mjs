#!/usr/bin/env node
/**
 * dist/ 를 지우고 나서 tsc 가 새로 쓰게 한다.
 *
 * tsc 는 자기가 더 이상 만들지 않는 파일을 지우지 않는다. 이 저장소는 dist/ 를
 * 커밋하므로, 한 번 나온 산출물은 지우지 않으면 그대로 커밋에 남는다. 컴파일된
 * 테스트와 선언 파일을 emit 대상에서 뺀 뒤에도 예전 것이 남아 있으면 CI 의
 * `git diff --exit-code -- dist` 는 통과하면서 쓸모없는 파일만 계속 배포된다.
 */

import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');

rmSync(distDir, { recursive: true, force: true });
console.log(`Cleaned ${distDir}`);
