import fs from 'fs';
import path from 'path';

function generateFileTree(dirPath, relativeTo = '') {
    const tree = [];

    try {
        const items = fs.readdirSync(dirPath);

        for (const item of items) {
            if (
                item === 'node_modules' || 
                item === '.git' || 
                item === '.next' ||
                item === 'hidden-tests' ||
                item === '__tests__' ||
                item === 'vitest.config.js' ||
                item === 'setupTests.js' ||
                item.endsWith('.test.js') ||
                item.endsWith('.test.jsx') ||
                item.startsWith('test_') ||
                item.endsWith('Test.java') ||
                item.endsWith('Tests.java')
            ) continue;

            const fullPath = path.join(dirPath, item);
            const relativePath = path.join(relativeTo, item).replace(/\\/g, '/');
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                tree.push({
                    name: item,
                    type: 'directory',
                    path: relativePath,
                    children: generateFileTree(fullPath, relativePath)
                });
            } else {
                tree.push({
                    name: item,
                    type: 'file',
                    path: relativePath,
                    size: stat.size
                });
            }
        }
    } catch (error) {
        console.error(`Error reading directory ${dirPath}:`, error);
        return null;
    }

    return tree.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'directory' ? -1 : 1;
    });
}

function getFileContent(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error);
        return null;
    }
}

export { generateFileTree, getFileContent };
