// Parse browser modules without executing them or contacting external services.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const repositoryRoot = path.resolve(process.argv[2]);
const pages = JSON.parse(fs.readFileSync(0, 'utf8'));
const checkedModules = new Set();

function checkModule(source, moduleUrl) {
    const parsedModule = new vm.SourceTextModule(source, { identifier: moduleUrl.href });
    for (const dependency of parsedModule.dependencySpecifiers) {
        checkModuleFile(new URL(dependency, moduleUrl));
    }
}

function checkModuleFile(moduleUrl) {
    if (moduleUrl.origin !== 'http://localhost') {
        throw new Error(`External module is not covered by this offline check: ${moduleUrl.href}`);
    }
    if (checkedModules.has(moduleUrl.pathname)) return;
    checkedModules.add(moduleUrl.pathname);

    const filename = path.resolve(repositoryRoot, `.${decodeURIComponent(moduleUrl.pathname)}`);
    const staticDirectory = path.join(repositoryRoot, 'static') + path.sep;
    if (!filename.startsWith(staticDirectory) || !fs.existsSync(filename)) {
        throw new Error(`Missing browser module: ${moduleUrl.pathname}`);
    }
    checkModule(fs.readFileSync(filename, 'utf8'), moduleUrl);
}

for (const page of pages) {
    const pageUrl = new URL(page.path, 'http://localhost');
    for (const script of page.scripts) {
        if (script.src) {
            checkModuleFile(new URL(script.src, pageUrl));
        } else {
            checkModule(script.source, pageUrl);
        }
    }
}
console.log(`Checked ${checkedModules.size} browser modules and their imports.`);
