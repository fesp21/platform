'use strict'; 

var mongoose = require('mongoose');
var debug = require('debug')('dockunit');
var Project = mongoose.model('Project');
var Build = mongoose.model('Build');
var NPromise = require('promise');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var Github = require('./Github');
var constants = require('../constants');
var Convert = require('ansi-to-html');

var Builder = function(user, project, buildId) {
	var self = this;

	self.socket = require('socket.io-client')('http://localhost:3000');

	return new NPromise(function(fulfill, reject) {
		self.project = project;
		self.buildId = buildId;
		self.user = user;
		self.output = '';

		var stepIndex = 0;

		var steps = [
			self.getBuild,
			self.startContainer,
			self.finish
		];

		function run() {
			if (!steps[stepIndex]) {
				debug('Build complete');
				fulfill(self.output);
			} else {
				NPromise.resolve(steps[stepIndex].apply(self)).then(function(result) {
					stepIndex++;
					run();
				}, function(error) {
					debug('Exiting from error: ' + error);
					reject();
				});
			}
		}

		run();
	});
};

Builder.prototype.getBuild = function() {
	var self = this;

	debug('Getting build model');

	return new NPromise(function(fulfill, reject) {

		Build.find({ _id: self.buildId }, function(error, builds) {
			if (error || !builds.length) {
				debug('Could not get build');

				reject(new Error('Could not find build with id `' + self.buildId + '`'));
			} else {
				self.build = builds[0];

				self.build.output = '';
				self.build.result = 0;
				self.build.finished = null;
				self.build.started = new Date();
				self.build.outputCode = null;

				self.build.save(function(error) {
					if (error) {
						reject(new Error('Could not save updated build'));
					} else {
						debug('Emitting updated build to ' + self.user.username);

						console.log({ build: self.build, user: self.user.username, repository: self.project.repository });

						self.socket.emit('updatedBuild', { build: self.build, user: self.user.username, repository: self.project.repository });

						fulfill();
					}
				});
			}
		});
	});
};

Builder.prototype.startContainer = function() {
	var self = this;

	return new NPromise(function(fulfill, reject) {
		debug('Starting git clone');

		debug('Start container');

		var directory = '/temp';
		if (constants.isDevelopment) {
			directory = process.env.HOME + '/buildfiles'
		}

		debug('Running - git clone https://github.com/' + self.project.repository + '.git ' + directory + '/' + self.project.repository + '/' + self.build.commit + ' && cd ' + directory + '/' + self.project.repository + '/' + self.build.commit + ' && git reset --hard ' + self.build.commit);

		// Todo: This will need to be optmized later so it doesn't clone all the history
		exec('git clone https://github.com/' + self.project.repository + '.git ' + directory + '/' + self.project.repository + '/' + self.build.commit + ' && cd ' + directory + '/' + self.project.repository + '/' + self.build.commit + ' && git reset --hard ' + self.build.commit, function(error, stdout, stderr) {
			debug('Git clone finished');

			var cmd = spawn('dockunit', [directory + '/' + self.project.repository + '/' + self.build.commit]);
			cmd.stdout.on('data', function(data) {
				console.log('' + data);
				self.output += '' + data;
			});

			cmd.stderr.on('data', function(data) {
				console.log('' + data);
				self.output += '' + data;
			});

			var called = false;

			function dockunitCallback(code, signal) {
				if (called) {
					return false;
				}

				called = true;

				debug('Dockunit command exited with code ' + code);
				self.outputCode = code;

				var convert = new Convert();
				self.output = convert.toHtml(self.output.trim().replace(/^(\r\n|\n|\r)/g, '').replace(/(\r\n|\n|\r)$/g, ''));
				
				exec('rm -rf ' + directory + '/' + self.project.repository + '/' + self.build.commit, function(error, stdout, stderr) {
					debug('Removed repo files');
					fulfill(self.output);
				});
			}

			cmd.on('exit', dockunitCallback);
			cmd.on('disconnect', dockunitCallback);
			cmd.on('close', dockunitCallback);
			cmd.on('error', dockunitCallback);

		});
	});
};

Builder.prototype.finish = function() {
	var self = this;

	debug('Finish build');

	return new NPromise(function(fulfill, reject) {
		self.build.output = self.output;
		self.build.finished = new Date();
		self.build.result = self.outputCode;

		self.build.save(function(error) {
			if (error) {
				reject();
				return;
			}

			debug('Emitting completed build to ' + self.user.username);

			var status = 'success';
			if (1 === build.result) {
				status = 'error';
			} else if (2 === build.result) {
				status = 'failure';
			}

			Github.statuses.create(self.user.githubAccessToken, self.project.repository, self.user.username, self.build.commit, status);

			self.socket.emit('completedBuild', { build: self.build, user: self.user.username, repository: self.project.repository });

			console.log({ build: self.build, user: self.user.username, repository: self.project.repository });

			debug('Build finish saved to project');

			fulfill();
		})
	});
};

module.exports = Builder;
