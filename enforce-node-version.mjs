const MIN_NODE_MAJOR = 20;

const [majorText] = process.versions.node.split('.');
const major = Number.parseInt(majorText, 10);

if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
  console.error(
    `Nimbus requires Node.js ${MIN_NODE_MAJOR}+ (detected ${process.versions.node}). ` +
      'Run `nvm use` at repo root to switch to the pinned version.'
  );
  process.exit(1);
}
