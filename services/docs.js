/**
 * Copyright 2015, Yahoo! Inc.
 * Copyrights licensed under the New BSD License. See the accompanying LICENSE file for terms.
 */

import async from 'async';
import debugLib from 'debug';
import fs from 'fs';
import getSearchIndexPath from '../utils/getSearchIndexPath';
import highlight from 'highlight.js';
import lunr from 'lunr';
import marked from 'marked';
import qs from 'querystring';
import renderer from './../utils/renderer';
import request from 'superagent';
import routes from '../configs/routes';
import secrets from './../secrets';
import url from 'url';
import semver from 'semver';

const debug = debugLib('DocsService');
const indexDb = getSearchIndexPath();

marked.setOptions({
    highlight: (code) => {
        return highlight.highlightAuto(code).value;
    }
});

// Generate a hash of valid api routes, from the /configs/apis.js file
let cache = {};
let documents = [];

// setup lunr index
const index = lunr(function () {
    debug('Creating lunr index');
    this.field('title', { boost: 10 });
    this.field('description', { boost: 5 });
    this.field('body');
    this.field('permalink');
});

/**
 * Generic function to call GitHub's 'repos' API
 * https://developer.github.com/v3/repos/
 *
 * @function fetchGitHubReposApi
 * @param {Object} params
 * @param {String} [params.repo=yahoo/fluxible] Repository
 * @param {String} params.type Type of data to fetch
 * @param {Function} cb Request callback function handler
 * @async
 */
function fetchGitHubReposApi(params, cb) {
    const repo = params.repo || 'yahoo/fluxible';
    const type = params.type;

    // create github api url
    let githubUrl = 'https://api.github.com/repos/' + repo + '/' + type + '?';

    // use access token if available, otherwise use client id and secret
    if (secrets.github.accessToken) {
        githubUrl += qs.stringify({
            access_token: secrets.github.accessToken
        });
    } else {
        githubUrl += qs.stringify({
            client_id: secrets.github.clientId,
            client_secret: secrets.github.clientSecret
        });
    }

    // the name of the commit/branch/tag
    if (params.ref) {
        githubUrl += '&ref=' + params.ref;
    }
    debug(githubUrl);

    request
    .get(githubUrl)
    .set('User-Agent', 'superagent')
    .end(cb);
}

/**
 * Gets the API docs content for fluxible repositories. Runs on an interval
 * to auto update the docs.
 *
 * @function fetchAPI
 * @param {Object} docParams Properties from route config
 * @param {Function} cb Async callback function
 * @async
 */
function fetchAPI(docParams, cb) {
    const title = docParams.pageTitlePrefix || docParams.pageTitle;
    const description = docParams.pageDescription;
    const githubRepo = docParams.githubRepo || 'yahoo/fluxible';
    const githubPath = docParams.githubPath;

    function fetchCallback(err, res) {
        if (err) {
            return cb(err);
        }

        let md = res.body && res.body.content; // base64 encoded string of the markdown file

        if (md) {
            let mdString = new Buffer(md, 'base64').toString(); // base64 decode

            let output = marked(mdString, {renderer: renderer});

            // Replace all .md links
            let linkRegex = /href="([^\"]+\.md)"/g;
            let replacements = [];
            let result;

            while ((result = linkRegex.exec(output)) !== null) {
                // Get the relative github path to link
                let fixedRelativePath = url.resolve(githubPath, result[1]);
                let matchedDoc;

                // Find the relative github path in routes
                /*jshint ignore:start */
                Object.keys(routes).forEach((routeName) => {
                    let routeConfig = routes[routeName];

                    if (
                        (fixedRelativePath === routeConfig.githubPath) ||
                        // support absolute urls of links from different repositories
                        (result[1].indexOf('http') !== -1 && result[1].indexOf(routeConfig.githubPath) !== -1)
                    ) {
                        matchedDoc = routeConfig;
                        return;
                    }
                });

                /*jshint ignore:end*/
                if (!matchedDoc) {
                    console.log(githubPath + ' has a broken link to ' + fixedRelativePath);
                    continue;
                }

                replacements.push([result[1], matchedDoc.path]);
                matchedDoc = null;
            }
            replacements.forEach(function (replacement) {
                output = output.replace(replacement[0], replacement[1]);
            });

            cache[githubPath] = {
                key: githubPath,
                content: output
            };

            // index document for searching
            debug('Adding %s to index', githubPath);
            const document = {
                id: githubPath,
                title: title,
                body: output,
                description: description,
                permalink: docParams.path
            };
            index.add(document);
            documents.push(document);

            return cb(null, cache[githubPath]);
        } else {
            console.error('Doc not found for', githubPath, res.body);

            cache[githubPath] = {
                key: githubPath,
                content: marked('# Doc Not Found: ' + githubPath, {renderer: renderer})
            };

            return cb(null, cache[githubPath]);
        }
    }

    fetchGitHubReposApi({
        repo: githubRepo,
        type: 'contents/' + githubPath,
        ref: docParams.githubRef
    }, fetchCallback);
}

/**
 * Fetches the npm version for the package given. Then uses that version
 * to check for matching branches in the libs repo. If found, the branch
 * is returned otherwise, defaults to `master`.
 *
 * @function fetchGitBranch
 * @param {String} pkg NPM package name
 * @param {Function} cb Async callback
 * @async
 */
function fetchGitBranch(pkg, cb) {
    var url = 'http://registry.npmjs.org/' + pkg;
    debug(url);

    request
    .get(url)
    .end(function (err, res) {
        let version;

        if (err || !res) {
            return cb(new Error('npm request failed: ' + url));
        }

        if (res.body && res.body['dist-tags']) {
            version = res.body['dist-tags'].latest;
        }

        // after we get the npm version of the package, we need to check and see if there is a
        // suitable branch on github with the same version. this way we can ensure we receive
        // the docs for the version published on npm.
        //
        // if we do not find a branch, then we default to 'master'.
        fetchGitHubReposApi({
            repo: 'yahoo/' + pkg,
            type: 'branches'
        }, function (err, res) {
            if (err || !res) {
                return cb(new Error('github branches failed for yahoo/' + pkg));
            }

            // default to master unless a branch match is found
            var githubRef = 'master';

            var branches = res.body;
            branches.forEach(function eachBranch(branch) {
                var branchName = branch.name;

                // branches start with 'v', need to remove that for semver comparison
                if (branchName.charAt(0) === 'v') {
                    branchName = branchName.substr(1);
                }
                debug('checking branches for ' + pkg, version, branchName, semver.satisfies(version, branchName));

                // check the cleaned branch name against the version in npm, if the branch
                // satisifes the version, then use the branch for the github API call
                if (semver.satisfies(version, branchName)) {
                    debug('found a branch that matches the npm version', version, branchName);
                    githubRef = branch.name;
                }
            });

            cb(null, githubRef);
        });
    });
}

/**
 * Gets the API docs content for fluxible repositories. Runs on an interval
 * to auto update the docs.
 *
 * 1. Call npm API to return git branch for fluxible and fluxible-addons-react.
 * 2. Uses these versions to make GitHub API calls for docs content
 *
 * @function refreshCacheFromGithub
 */
(function refreshCacheFromGithub() {
    var branchHash = {
        'yahoo/fluxible': null,
        'yahoo/fluxible-addons-react': null
    };
    async.auto({
        fluxibleBranch: function fluxibleBranchCb(cb) {
            fetchGitBranch('fluxible', cb);
        },
        fluxibleAddonsBranch: function fluxibleAddonsBranchCb(cb) {
            fetchGitBranch('fluxible-addons-react', cb);
        },
        fetchApi: ['fluxibleBranch', 'fluxibleAddonsBranch', function fetchApiCb(cb, results) {
            debug('fetchAPI version results', results);

            const fetches = [];
            branchHash['yahoo/fluxible'] = results.fluxibleBranch;
            branchHash['yahoo/fluxible-addons-react'] = results.fluxibleAddonsBranch;

            Object.keys(routes).forEach(function eachRoute(routeName) {
                let routeConfig = routes[routeName];

                // pass branch name to pull specific branch from github
                routeConfig.githubRef = branchHash[routeConfig.githubRepo];

                if (routeConfig.githubPath) {
                    fetches.push(function eachTask(cb) {
                        fetchAPI(routeConfig, cb);
                    });
                }
            });

            async.parallel(fetches, function npmFetchesCallback(err) {
                if (err) {
                    return console.error(err);
                }

                // save index
                const data = {
                    docs: documents,
                    index: index.toJSON()
                };

                fs.writeFileSync(indexDb, JSON.stringify(data));
            });
        }]
    });

    setTimeout(refreshCacheFromGithub, 60 * 60 * 1000); // refresh cache every hour
})();

export default {
    name: 'docs',
    read: function (req, resource, params, config, callback) {
        // Return immediately if repo's readme is in cache
        if (cache[params.path]) {
            return callback(null, cache[params.path]);
        } else {
            return fetchAPI(params.path);
        }
    }
};
