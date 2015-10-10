/*jslint node: true, vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 2, maxerr: 50 */
/*global define, $, brackets, Mustache, window, console */
define(function (require, exports, module) {
	"use strict";

	// HEADER >>
	var PathManager = require("modules/PathManager"),
			FileSystem = brackets.getModule("filesystem/FileSystem"),
			ProjectManager = brackets.getModule("project/ProjectManager"),
			Async = brackets.getModule("utils/Async"),
			FileUtils = brackets.getModule("file/FileUtils"),
			PreferencesManager = brackets.getModule("preferences/PreferencesManager"),
			ExtentionUtils = brackets.getModule("utils/ExtensionUtils"),
			FileTreeView = require("modules/FileTreeView"),
			MainViewManager = brackets.getModule("view/MainViewManager"),
			EventDispatcher = brackets.getModule("utils/EventDispatcher"),
			moment = require("node_modules/moment/moment"),
			_ = brackets.getModule("thirdparty/lodash"),
			DocumentManager = brackets.getModule("document/DocumentManager"),
			Log = require("modules/Log");

	var open,
			close,
			closeProject,
			isOpen,
			getOpenProjectDocuments,
			getServerSetting,
			createDirectoryIfExists,
			renameLocalEntry,
			maxProjectHistory = 10;

	var
			_initProjectContext,
			_createSettingDirIfIsNotExists,
			_createDirectory;

	var _currentServer,
			_hostDir,
			_projectDir,
			_projectBaseDir,
			_fallbackProjectRoot,
			_getDirectoryContents,
			_removeDirectoryContents,
			_removeContent,
			_removeProjectDirectoryFromRecent;

	var OPEN = true,
			CLOSE = false,
			PROJECT_STATE_CHANGED = "PROJECT_STATE_CHANGED",
			STATE = {
				_state: CLOSE,
				isOpen: function () {
					return this._state === OPEN;
				},
				setOpen: function () {
					this._state = OPEN;
					exports.trigger(PROJECT_STATE_CHANGED, {state: OPEN, directory: _projectDir});
				},
				setClose: function () {
					this._state = CLOSE;
					exports.trigger(PROJECT_STATE_CHANGED, {state: CLOSE, directory: _projectDir});
				}
			};
	//<<


	/**
	 * Open the project when the success connected to server.
	 *
	 * * and this function, that will checked. is that exists tmporary diredtory and make.
	 * * and this function will checked backup number via maxProjectHistory.
	 *
	 * @param   {Object}   server setting object
	 * @returns {$.Promise}
	 */
	open = function (server) {
		_currentServer = server;
		var deferred = new $.Deferred();
		
		/**
		 * The function will be confirm whether __PROJ__ directory is exists or not.
		 */
		_initProjectContext()
		.then(function () {
			return _createSettingDirIfIsNotExists(_currentServer);
		}, function (err) {
			deferred.reject(err);
		})
		.then(_getDirectoryContents, function (err) {
			deferred.reject(err);
		})
		.then(function (contents) {
			var d = new $.Deferred();
			var m = moment();
			var now = m.format("YYYYMMDDHHmmss");
			_projectDir =
				FileSystem.getDirectoryForPath(
					PathManager.getProjectDirectoryPath(server.name + "_" + server.host + "_" + server.user + "/" + now));

			_projectDir.create(function (err, stats) {
				if (err) {
					Log.q("Failed to create the current project directory", true, err);
					d.reject(err).promise();
				} else {
					var tmp = [];
					if ((contents.length + 1) > maxProjectHistory) {
						_.forEach(contents, function (content) {
							tmp.push(content.name);
						});
						var dirs = _.sortBy(tmp, function (num) {
							return num;
						});
						var offset = (contents.length + 1) - maxProjectHistory;
						var i = 0;

						var _moveToTrash = function (server, dirNames) {
							var dd = new $.Deferred();
							var item = FileSystem.getDirectoryForPath(PathManager.getProjectDirectoryPath(server.name + "_" + server.host + "_" + server.user + "/" + dirNames));

							ProjectManager.deleteItem(item)
							.then(dd.resolve, function (err) {
								Log.q("Failed to delete the old project.", true, err);
								dd.reject(err);
							});
							return dd.promise();
						};

						var promises = [];
						for (; i < offset; i++) {
							var dirNames = dirs.shift();
							promises.push(_moveToTrash(server, dirNames));
						}

						Async.waitForAll(promises, true, 3000)
						.then(d.resolve, function (err) {
							err = new Error({message: "Error occured at the _Project.open function", err: err});
							d.reject(err);
						});
					} else {
						d.resolve();
					}
				}
			});
			return d.promise();
		}, deferred.reject)
		.then(function () {
			_fallbackProjectRoot = ProjectManager.getProjectRoot().fullPath;
			return ProjectManager.openProject(_projectDir.fullPath);
		})
		.then(function () {
			STATE.setOpen();
			deferred.resolve();
		}, function (err) {
			STATE.setClose();
			Log.q("Failed to open the project", true, err);
			deferred.reject(err);
		});

		return deferred.promise();
	};

	/**
	 * Erase files in the tree view then remove recent project (backup temporary directory) from preference.
	 *
	 * @returns {$.Promise}
	 */
	close = function () {
		var deferred = new $.Deferred();
		FileTreeView.clearCurrentTree()
		.then(_removeProjectDirectoryFromRecent)
		.then(function () {
			STATE.setClose();
			deferred.resolve();
		});
		return deferred.promise();
	};

	/**
	 * Open stored project, that is stored at before connection established
	 *
	 * @returns {$.Promise}
	 */
	closeProject = function () {
		if (STATE.isOpen()) {
			return ProjectManager.openProject(_fallbackProjectRoot);
		}
	};

	/**
	 * it will back boolean to caller, if it is true when opened Synapse project
	 *
	 * @returns {$.Promise}
	 */
	isOpen = function () {
		return STATE.isOpen();
	};

	/**
	 * It open file to current editor
	 *
	 * @returns {Array} array of Document object.
	 */
	getOpenProjectDocuments = function () {
		var deferred = new $.Deferred();
		var tmp = [];
		if (STATE.isOpen()) {
			var files = MainViewManager.getAllOpenFiles();
			_.forEach(files, function (file) {
				tmp.push(DocumentManager.getOpenDocumentForPath(file.fullPath));
			});
		}
		return deferred.resolve(tmp).promise();
	};

	/**
	 * It will be back current server setting object.
	 *
	 * @returns {MIX}
	 */
	getServerSetting = function () {
		if (STATE.isOpen()) {
			return _currentServer;
		} else {
			return false;
		}
	};


	createDirectoryIfExists = function (path) {
		var d = new $.Deferred();
		var dir = FileSystem.getDirectoryForPath(path);
		dir.exists(function (err, exists) {
			if (exists) {
				d.resolve();
			} else {
				dir.create(function (err) {
					if (err) {
						// TODO: ディレクトリの作成に失敗しました。
						d.reject(err);
					} else {
						d.resolve();
					}
				});
			}
		});
		return d.promise();
	};


	renameLocalEntry = function (oldPath, newPath, type) {
		var d = new $.Deferred();
		var oldEntry = null,
				newEntry = null;
		if (type === "file") {
			oldEntry = FileSystem.getFileForPath(oldPath);
		} else {
			oldEntry = FileSystem.getDirectoryForPath(oldPath);
		}
		oldEntry.exists(function (err, exists) {
			if (exists) {
				oldEntry.rename(newPath, function (err) {
					if (err) {
						// TODO: ファイル名の変更に失敗しました。
						d.reject(err);
					} else {
						d.resolve();
					}
				});
			}
			d.resolve();
		});
		return d.promise();
	};


	
	/**
	 * This function will be confirm whether the individual server setting directory is exists of not,
	 * create that if is not exists.
	 */
	_createSettingDirIfIsNotExists = function (server) {
		var deferred = new $.Deferred(),
				_settingDir = FileSystem.getDirectoryForPath(PathManager.getProjectDirectoryPath(server.name + "_" + server.host + "_" + server.user));
		
		(function () {
			var d = new $.Deferred();
			_settingDir.exists(function (err, exists) {
				if (err) {
					Log.q("Failed to confirm whether the individual server setting directory is exists or not.", true, err);
					console.error(err);
					d.reject(err);
				} else {
					d.resolve(_settingDir, exists);
				}
			});
			return d.promise();
		}())
		.then(function (_settingDir, exists) {
			var d = new $.Deferred();
			if (!exists) {
				_settingDir.create(function (err, res) {
					if (err) {
						Log.q("Failed to create the individual server setting directory.", true, err);
						console.error(err);
						d.reject(err);
					} else {
						d.resolve(_settingDir);
					}
				});
			} else {
				d.resolve(_settingDir);
			}
			return d.promise();
		}, function (err) {
			// anonymous function rejected.
			err = new Error({message: "Error occured at Project._createSettingDirIfIsNotExists.", err: err});
			console.error(err);
			deferred.reject(err);
		})
		.then(deferred.resolve, deferred.reject);
		return deferred.promise();
	};

	/**
	 * This function will be confirm whether the directory for the remote project (__PROJ__ directory) for project is exists or not.
	 * 
	 * @return {$.Promise} a promise, that will be resolved when the base directory is exists
	 * 																or that created if is not exists, or rejected.
	 */
	_initProjectContext = function () {
		var deferred = new $.Deferred();
		_projectBaseDir = FileSystem.getDirectoryForPath(PathManager.getProjectDirectoryPath());
		(function () {
			var d = new $.Deferred();
			_projectBaseDir.exists(function (err, res) {
				if (err) {
					Log.q("Failed to confirm function whether __PROJ__ directory is not exists or not.", true, err);
					d.reject(err);
				} else {
					d.resolve(res);
				}
			});
			return d.promise();
		}())
		.then(function (res) {
			if (!res) {
				_projectBaseDir.create(function (err, res) {
					if (err) {
						return deferred.reject(err).promise();
					} else {
						deferred.resolve();
					}
				});
			} else {
				deferred.resolve();
			}
		}, function (err) {
			// _projectBaseDir.exists is rejected
			Log.q("Failed to confirm whether the directory for the remote project is exists or not.", true, err);
			deferred.reject(err);
		});
		return deferred.promise();
	};

	

	_getDirectoryContents = function (directory) {
		var deferred = new $.Deferred();
		directory.getContents(function (err, contents, stats, obj) {
			if (err) {
				Log.q("Failed to read the directory contents", true, err);
				deferred.rejecte(err);
			} else {
				deferred.resolve(contents);
			}
		});
		return deferred.promise();
	};

	_removeDirectoryContents = function (contents) {
		if (contents.length === 0) {
			return new $.Deferred().resolve().promise();
		}
		var funcs = [];
		contents.forEach(function (entity) {
			funcs.push(_removeContent(entity));
		});

		return Async.WaitForAll(funcs, true);
	};

	_removeContent = function (entity) {
		var deferred = new $.Deferred();
		entity.moveToTrash(function (err) {
			if (err) {
				deferred.reject(err);
			} else {
				deferred.resolve();
			}
		});
		return deferred.promise();
	};

	_removeProjectDirectoryFromRecent = function () {
		function getRecentProject() {
			var recents = PreferencesManager.getViewState("recentProjects") || [],
				i;
			for (i = 0; i < recents.length; i++) {
				recents[i] = FileUtils.stripTrailingSlash(ProjectManager.updateWelcomeProjectPath(recents[i] + "/"));
			}
			return recents;
		}
		var recentProjects = getRecentProject(),
				newAry = [];
		recentProjects.forEach(function (item, idx) {
			if (item !== FileUtils.stripTrailingSlash(_projectDir.fullPath)) {
				newAry.push(item);
			}
		});
		PreferencesManager.setViewState("recentProjects", newAry);
		return new $.Deferred().resolve().promise();
	};



	EventDispatcher.makeEventDispatcher(exports);

	exports.open = open;
	exports.close = close;
	exports.isOpen = isOpen;
	exports.closeProject = closeProject;
	exports.OPEN = OPEN;
	exports.CLOSE = CLOSE;
	exports.STATE = STATE;
	exports.PROJECT_STATE_CHANGED = PROJECT_STATE_CHANGED;
	exports.getOpenProjectDocuments = getOpenProjectDocuments;
	exports.getServerSetting = getServerSetting;
	exports.createDirectoryIfExists = createDirectoryIfExists;
	exports.renameLocalEntry = renameLocalEntry;
});
