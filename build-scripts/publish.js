#!/usr/bin/env node
/*
 * Copyright 2022 The Closure Compiler Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';
/**
 * @fileoverview
 *
 * Publish each package in this project in order.
 * Packages can only be published after all their dependencies have been successfully published.
 */

const fs = require('fs/promises');
const graphlib = require('graphlib');
const path = require('path');
const runCommand = require('./run-command');

const packagesDirPath = path.resolve(__dirname, '../packages');

async function isPackageVersionPublished(packageName, version) {
  return fetch(`https://registry.npmjs.org/${encodeURI(packageName)}/${version}`)
      .then((res) => res.ok);
}

async function isValidPackagePath(packageDir) {
  const packageJsonPath = `${packageDir}/package.json`;
  try {
    // check to see if the file already exists - if so do nothing
    await fs.stat(packageJsonPath);
    return true;
  } catch {
    return false;
  }
}

async function getPackageInfo(packageDir) {
  return {
    path: packageDir,
    pkg: JSON.parse(await fs.readFile(`${packageDir}/package.json`, 'utf8'))
  };
}

async function setupNpm(npmrcPath) {
  // For npm publication to work, the NPM token must be stored in the .npmrc file
  if (process.env.GITHUB_ACTIONS && process.env.NPM_TOKEN) {
    await fs.writeFile(
        npmrcPath,
        `registry=https://registry.npmjs.org\n//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}\n`,
        'utf8');
  } else {
    console.log(
        'Not running in GitHub actions',
        Boolean(process.env.GITHUB_ACTIONS && process.env.NPM_TOKEN));
  }
}

async function cleanupNpmrc(npmrcPath) {
  await fs.unlink(npmrcPath);
}

async function publishPackagesIfNeeded(packageInfo) {
  const pkgJson = packageInfo.pkg;
  const isAlreadyPublished = await isPackageVersionPublished(pkgJson.name, pkgJson.version);
  if (isAlreadyPublished) {
    console.log('Already published', pkgJson.name, pkgJson.version);
    return;
  }
  console.log('Publishing', pkgJson.name, pkgJson.version);
  const publishArgs = ['publish', '--no-workspaces'];
  if (process.env.COMPILER_NIGHTLY ) {
    publishArgs.push('--npm-tag', 'nightly');
  }
  const npmrcPath = path.resolve(packageInfo.path, '.npmrc');
  await setupNpm(npmrcPath);
  await runCommand('npm', publishArgs, {
    cwd: packageInfo.path
  });
  await cleanupNpmrc(npmrcPath);
}

(async () => {
  const packagesDirEntries = await fs.readdir(packagesDirPath);
  // build a graph of the interdependencies of projects and only publish
  const graph = new graphlib.Graph({directed: true, compound: false});
  for (const packageDirName of packagesDirEntries) {
    const packagePath = `${packagesDirPath}/${packageDirName}`;
    if (await isValidPackagePath(packagePath)) {
      const packageInfo = await getPackageInfo(packagePath);
      graph.setNode(packageInfo.pkg.name, packageInfo);
    }
  }

  // Create edges from each package to any non-development dependency
  graph.nodes().forEach((packageName) => {
    const packageInfo = graph.node(packageName);
    const allDeps = Object.keys(packageInfo.pkg.dependencies || {})
        .concat(Object.keys(packageInfo.pkg.optionalDependencies || {}))
        .concat(Object.keys(packageInfo.pkg.peerDependencies || {}));
    allDeps.forEach((depName) => {
      if (graph.hasNode(depName)) {
        graph.setEdge(packageName, depName);
      }
    });
  });

  // Publish the packages in order
  const publishedPackages = new Set();
  while (publishedPackages.size !== graph.nodeCount()) {
    const startingSize = publishedPackages.size;
    // Find any package where all dependencies have already been published
    const packagesToPublish = graph.nodes().filter((packageName) => {
      const packageDeps = graph.outEdges(packageName).map((edge) => edge.w);
      return !publishedPackages.has(packageName) && packageDeps.every((depName) => publishedPackages.has(depName));
    });
    for (const packageName of packagesToPublish) {
      const packageInfo = graph.node(packageName);
      await publishPackagesIfNeeded(packageInfo);
      publishedPackages.add(packageName);
    }
    if (startingSize === publishedPackages.size) {
      throw new Error('Unable to publish packages: cyclical dependencies encountered.');
    }
  }
})().catch((e) => {
  throw e;
});
