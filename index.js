const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const fetch = require('node-fetch');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

async function run() {
    try {
        core.info("🚀 Wasted Lines Detector is starting...");
        
        const token = core.getInput('github_token');
        if (!token) {
            core.setFailed("❌ Error: Missing GitHub Token!");
            return;
        }
        
        const octokit = github.getOctokit(token);
        const { context } = github;
        const pr = context.payload.pull_request;
        if (!pr) {
            core.setFailed('❌ No pull request found.');
            return;
        }
        
        core.info(`🔍 PR Detected: #${pr.number} - Fetching changed files...`);

        const files = await octokit.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
        });

        let comments = [];
        
        for (const file of files.data) {
            if (!isSupportedFile(file.filename)) {
                core.info(`⏭ Skipping unsupported file: ${file.filename}`);
                continue;
            }

            core.info(`📄 Checking file: ${file.filename}`);
            const content = await fetchFileContent(file.raw_url);
            if (!content) {
                core.warning(`⚠️ Skipping ${file.filename} due to empty content.`);
                continue;
            }

            core.info(`🔍 Analyzing file: ${file.filename}`);
            const suggestions = analyzeCode(content, file.filename);

            if (suggestions.length > 0) {
                comments.push({
                    path: file.filename,
                    body: suggestions.join("\n"),
                    position: 1
                });
            }
        }

        if (comments.length > 0) {
            await octokit.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: pr.number,
                body: `### 🚀 Wasted Lines Detector Report\n\n${comments.map(c => `📌 **${c.path}**\n${c.body}`).join("\n\n")}`
            });
        } else {
            core.info("🎉 No wasted lines detected!");
        }
    } catch (error) {
        core.setFailed(`Error: ${error.message}`);
    }
}

// Check if file type is supported
function isSupportedFile(filename) {
    return filename.endsWith('.js') || filename.endsWith('.py') || filename.endsWith('.sh') || filename.endsWith('.rb') || filename.endsWith('.groovy');
}

// Fetch file content from GitHub properly
async function fetchFileContent(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            core.warning(`⚠️ Failed to fetch content: ${response.status} ${response.statusText}`);
            return '';
        }
        return await response.text();
    } catch (error) {
        core.warning(`⚠️ Error fetching file content: ${error.message}`);
        return '';
    }
}

// Analyze code for inefficiencies
function analyzeCode(content, filename) {
    let suggestions = [];
    
    try {
        if (filename.endsWith('.js')) {
            const ast = parse(content, { sourceType: "module" });
            
            traverse(ast, {
                IfStatement(path) {
                    if (path.node.test.type === 'BinaryExpression' && path.node.test.operator === '===') {
                        suggestions.push(`🔍 Boolean comparison can be simplified: \`if (${path.node.test.left.name})\``);
                    }
                },
                ForStatement(path) {
                    if (path.node.init && path.node.init.declarations && path.node.init.declarations[0].id.name === "i") {
                        suggestions.push("🔍 Consider replacing loop with `Array.prototype.map()`.");
                    }
                },
                VariableDeclarator(path) {
                    if (!path.scope.bindings[path.node.id.name].referenced) {
                        suggestions.push(`🔍 Unused variable detected: \`${path.node.id.name}\``);
                    }
                },
                CallExpression(path) {
                    if (path.node.callee.type === 'MemberExpression' && path.node.callee.property.name === 'log') {
                        suggestions.push("🔍 Too many console logs detected. Consider removing debug logs.");
                    }
                }
            });
        } else if (filename.endsWith('.py')) {
            if (/print\(.*\)/g.test(content)) {
                suggestions.push("🔍 Too many print statements detected in Python file.");
            }
            if (/if\s+.*\s+==\s+True:/g.test(content)) {
                suggestions.push("🔍 Boolean comparison can be simplified: `if condition`.");
            }
        } else if (filename.endsWith('.sh')) {
            if (/echo\s+.*$/g.test(content)) {
                suggestions.push("🔍 Too many echo statements detected in Shell script.");
            }
        } else if (filename.endsWith('.rb')) {
            if (/puts\s+.*$/g.test(content)) {
                suggestions.push("🔍 Too many puts statements detected in Ruby script.");
            }
        } else if (filename.endsWith('.groovy')) {
            if (/println\s+.*$/g.test(content)) {
                suggestions.push("🔍 Too many println statements detected in Groovy script.");
            }
        }
    } catch (error) {
        core.warning(`⚠️ Parsing failed for ${filename}: ${error.message}`);
    }
    return suggestions;
}

run();
