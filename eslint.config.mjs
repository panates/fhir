import fs from 'node:fs';
import panatesEslint from '@panates/eslint-config-ts';
import globals from 'globals';

const root = import.meta.dirname;

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      'node_modules/**/*',
      'packages/*/node_modules/**/*',
      'packages/*/build/**/*',
      // pnpm examples compiles the examples here
      'examples/build/**/*',
    ],
  },
  ...panatesEslint.configs.node,
  {
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
  },
  // A package's tests use its siblings (the client's tests run a server, the
  // server's run a client) through the root's devDependencies: as devDependencies
  // of the packages they would make a cycle that has no build order
  ...fs.readdirSync(`${root}/packages`).map(name => ({
    files: [`packages/${name}/test/**/*`],
    rules: {
      'import-x/no-extraneous-dependencies': [
        'error',
        { packageDir: [`${root}/packages/${name}`, root] },
      ],
    },
  })),
];
