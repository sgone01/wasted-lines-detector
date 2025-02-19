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
            const content = await fetchFileContent(octokit, context.repo.owner, context.repo.repo, file.filename, pr.head.ref); // Use pr.head.ref
            if (!content) {
                core.warning(`⚠️ Skipping ${file.filename} due to empty content.`);
                continue;
            }

            core.info(`🔍 Analyzing file: ${file.filename}`);
            const suggestions = analyzeCode(content, file.filename);

            if (suggestions.length > 0) {
                suggestions.forEach(suggestion => {
                    comments.push({
                        path: file.filename,
                        body: suggestion.message,
                        position: suggestion.line
                    });
                });
            }
        }

        if (comments.length > 0) {
            const commentBody = `### 🚀 Wasted Lines Detector Report\n\n${comments.map(c => `📌 **${c.path}**, line ${c.position}:\n${c.body}`).join("\n\n")}`;

            await octokit.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: pr.number,
                body: commentBody
            }).catch(error => {
                core.error(`❌ Failed to create comment: ${error.message}`);
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
async function fetchFileContent(octokit, repoOwner, repoName, filePath, branch) {
    try {
        const response = await octokit.rest.repos.getContent({
            owner: repoOwner,
            repo: repoName,
            path: filePath,
            ref: branch
        });

        if (!response || !response.data || !response.data.content) {
            core.warning(`⚠️ Failed to fetch content: No content found for ${filePath}`);
            return '';
        }

        const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
        return content;
    } catch (error) {
        core.warning(`⚠️ Error fetching file content for ${filePath}: ${error.message}`);
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
                        suggestions.push({
                            message: `🔍 Boolean comparison can be simplified: \`if (${path.node.test.left.name})\``,
                            line: path.node.loc.start.line
                        });
                    } else if (path.node.test.type === 'BooleanLiteral' && (path.node.test.value === true || path.node.test.value === false)) {
                        suggestions.push({
                            message: "🔍 Redundant boolean literal in `if` condition",
                            line: path.node.loc.start.line
                        });
                    }
                },
                ForStatement(path) {
                    if (path.node.init && path.node.init.declarations && path.node.init.declarations[0].id.name === "i") {
                        suggestions.push({
                            message: "🔍 Consider replacing basic `for` loop with `Array.prototype.forEach()` or `Array.prototype.map()` for improved readability.",
                            line: path.node.loc.start.line
                        });
                    }
                },
                VariableDeclarator(path) {
                    if (!path.scope.bindings[path.node.id.name].referenced) {
                        suggestions.push({
                            message: `🔍 Unused variable detected: \`${path.node.id.name}\``,
                            line: path.node.loc.start.line
                        });
                    }
                },
                CallExpression(path) {
                    if (path.node.callee.type === 'MemberExpression' && path.node.callee.property.name === 'log') {
                        suggestions.push({
                            message: "🔍 Too many console logs detected. Consider removing debug logs.",
                            line: path.node.loc.start.line
                        });
                    }
                }
            });
        } else if (filename.endsWith('.py')) {
            content.split('\n').forEach((line, index) => {
                const lineNumber = index + 1;
                if (/print\(.*\)/g.test(line)) {
                    suggestions.push({ message: "🔍 Too many print statements detected in Python file.", line: lineNumber });
                }
                if (/if\s+.*\s+==\s+True:/g.test(line)) {
                    suggestions.push({ message: "🔍 Boolean comparison can be simplified: `if condition`.", line: lineNumber });
                }
            });
        } else if (filename.endsWith('.sh')) {
            content.split('\n').forEach((line, index) => {
                const lineNumber = index + 1;
                if (/echo\s+.*$/g.test(line)) {
                    suggestions.push({ message: "🔍 Too many echo statements detected in Shell script.", line: lineNumber });
                }
            });
        } else if (filename.endsWith('.rb')) {
            content.split('\n').forEach((line, index) => {
                const lineNumber = index + 1;
                if (/puts\s+.*$/g.test(line)) {
                    suggestions.push({ message: "🔍 Too many puts statements detected in Ruby script.", line: lineNumber });
                }
            });
        } else if (filename.endsWith('.groovy')) {
            content.split('\n').forEach((line, index) => {
                const lineNumber = index + 1;
                if (/println\s+.*$/g.test(line)) {
                    suggestions.push({ message: "🔍 Too many println statements detected in Groovy script.", line: lineNumber });
                }
            });
        }
    } catch (error) {
        core.warning(`⚠️ Parsing failed for ${filename}: ${error.message}`);
    }
    return suggestions;
}

run();
