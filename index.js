const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

async function run() {
    try {
        core.info("🚀 Wasted Lines Detector is starting...");

        const token = process.env.GITHUB_TOKEN || core.getInput('github_token');
        const useAiTool = core.getInput('use_ai_tool') === 'true';
        const aiApiKey = process.env.AI_API_KEY || core.getInput('ai_api_key');
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

        const comments = await analyzeFiles(files.data, octokit, context.repo, pr.head.ref, useAiTool, aiApiKey);

        if (comments.length > 0) {
            const commentBody = generateCommentBody(comments, context.repo, pr.head.ref);

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

async function analyzeFiles(files, octokit, repo, branch, useAiTool, aiApiKey) {
    let comments = [];

    for (const file of files) {
        if (!isSupportedFile(file.filename)) {
            core.info(`⏭ Skipping unsupported file: ${file.filename}`);
            continue;
        }

        core.info(`📄 Checking file: ${file.filename}`);
        const content = await fetchFileContent(octokit, repo.owner, repo.repo, file.filename, branch);
        if (!content) {
            core.warning(`⚠️ Skipping ${file.filename} due to empty content.`);
            continue;
        }

        core.info(`🔍 Analyzing file: ${file.filename}`);
        const suggestions = useAiTool ? await getSuggestionsFromAiTool(content, aiApiKey, file.filename) : analyzeCode(content, file.filename);

        if (suggestions.length > 0) {
            suggestions.forEach(suggestion => {
                comments.push({
                    path: file.filename,
                    body: suggestion,
                    position: suggestion.line
                });
            });
        }
    }

    return comments;
}

async function fetchFileContent(octokit, owner, repo, path, ref) {
    const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
    });

    const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
    return content;
}

async function getSuggestionsFromAiTool(content, apiKey, filename) {
    const language = getLanguageFromFilename(filename);
    const apiUrl = 'https://api.x.ai/v1/chat/completions';
    const requestBody = {
        messages: [
            {
                role: "system",
                content: "You are a test assistant."
            },
            {
                role: "user",
                content: `Review the following ${language} code and suggest improvements:\n\n${content}`
            }
        ],
        model: "grok-2-latest",
        stream: false,
        temperature: 0
    };

    const response = await axios.post(apiUrl, requestBody, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    });

    const suggestions = response.data.choices ? response.data.choices[0].message.content.trim() : '';
    return suggestions;
}

function getLanguageFromFilename(filename) {
    if (filename.endsWith('.js')) return 'javascript';
    if (filename.endsWith('.py')) return 'python';
    if (filename.endsWith('.sh')) return 'shell';
    if (filename.endsWith('.rb')) return 'ruby';
    if (filename.endsWith('.groovy')) return 'groovy';
    return '';
}

function analyzeCode(content, filename) {
    let suggestions = [];

    try {
        if (filename.endsWith('.js')) {
            const ast = parse(content, { sourceType: "module", plugins: ["jsx"] });

            traverse(ast, {
                IfStatement(path) {
                    checkIfStatement(path, suggestions);
                },
                ForStatement(path) {
                    checkForStatement(path, suggestions);
                },
                VariableDeclarator(path) {
                    checkVariableDeclarator(path, suggestions);
                },
                CallExpression(path) {
                    checkCallExpression(path, suggestions);
                }
            });
        } else {
            analyzeNonJsCode(content, filename, suggestions);
        }
    } catch (error) {
        core.warning(`⚠️ Parsing failed for ${filename}: ${error.message}`);
    }
    return suggestions;
}

function checkIfStatement(path, suggestions) {
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
}

function checkForStatement(path, suggestions) {
    if (path.node.init && path.node.init.declarations && path.node.init.declarations[0].id.name === "i") {
        suggestions.push({
            message: "🔍 Consider replacing basic `for` loop with `Array.prototype.forEach()` or `Array.prototype.map()` for improved readability.",
            line: path.node.loc.start.line
        });
    }
}

function checkVariableDeclarator(path, suggestions) {
    const variableName = path.node.id.name;
    if (!path.scope.bindings[variableName].referenced) {
        suggestions.push({
            message: `🔍 Unused variable detected: \`${variableName}\``,
            line: path.node.loc.start.line
        });
    }
}

function checkCallExpression(path, suggestions) {
    if (path.node.callee.type === 'MemberExpression' && path.node.callee.property.name === 'log') {
        suggestions.push({
            message: "🔍 Too many console logs detected. Consider removing debug logs.",
            line: path.node.loc.start.line
        });
    }
}

function analyzeNonJsCode(content, filename, suggestions) {
    const lines = content.split('\n');
    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        if (filename.endsWith('.py')) {
            if (/print\(.*\)/g.test(line)) {
                suggestions.push({ message: "🔍 Too many print statements detected in Python file.", line: lineNumber });
            }
            if (/if\s+.*\s+==\s+True:/g.test(line)) {
                suggestions.push({ message: "🔍 Boolean comparison can be simplified: `if condition`.", line: lineNumber });
            }
        } else if (filename.endsWith('.sh')) {
            if (/echo\s+.*$/g.test(line)) {
                suggestions.push({ message: "🔍 Too many echo statements detected in Shell script.", line: lineNumber });
            }
        } else if (filename.endsWith('.rb')) {
            if (/puts\s+.*$/g.test(line)) {
                suggestions.push({ message: "🔍 Too many puts statements detected in Ruby script.", line: lineNumber });
            }
        } else if (filename.endsWith('.groovy')) {
            if (/println\s+.*$/g.test(line)) {
                suggestions.push({ message: "🔍 Too many println statements detected in Groovy script.", line: lineNumber });
            }
        }
    });
}

function generateCommentBody(comments, repo, ref) {
    const groupedComments = comments.reduce((acc, comment) => {
        if (!acc[comment.path]) {
            acc[comment.path] = [];
        }
        acc[comment.path].push(comment);
        return acc;
    }, {});

    const repoUrl = `https://github.com/${repo.owner}/${repo.repo}/blob/${ref}`;

    let commentBody = `### 🚀 Wasted Lines Detector Report \n\n`;
    for (const [file, issues] of Object.entries(groupedComments)) {
        commentBody += `📄 **[${file}](${repoUrl}/${file})**\n`;

        issues.forEach(issue => {
            commentBody += `\n**Suggestion:**\n`;
            commentBody += `\`\`\`${getLanguageFromFilename(file)}\n${issue.body}\n\`\`\`\n`;
        });
        commentBody += '\n';
    }

    return commentBody;
}

function isSupportedFile(filename) {
    const supportedExtensions = ['.js', '.py', '.sh', '.rb', '.groovy'];
    return supportedExtensions.some(ext => filename.endsWith(ext));
}

run();