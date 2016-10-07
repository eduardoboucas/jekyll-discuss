var GitHubApi = require('github')
var md5 = require('md5')
var objectPath = require('object-path')
var sha1 = require('sha1')
var yaml = require('js-yaml')

var Staticman = function (options, localConfig) {
  this.options = options
  this.localConfig = localConfig

  this.initGithub()
}

Staticman.prototype._applyGeneratedFields = function (data) {
  if (!this.config.generatedFields) return data

  Object.keys(this.config.generatedFields).forEach((field) => {
    var generatedField = this.config.generatedFields[field]
    var options = generatedField.options || {}

    switch (generatedField.type) {
      case 'date':
        data[field] = this._createDate(options)
    }
  })

  return data
}

Staticman.prototype._applyTransforms = function (data) {
  if (!this.config.transforms) return Promise.resolve(data)

  var queue = []

  Object.keys(this.config.transforms).forEach((field) => {
    if (!data[field]) return

    if (this.config.transforms[field] === 'md5') {
      data[field] = md5(data[field])
    }
  })

  return Promise.all(queue).then((results) => {
    return data
  })
}

Staticman.prototype._checkForSpam = function (fields) {
  if (!this.config.akismet || !this.config.akismet.type) return Promise.resolve(fields)

  return new Promise((resolve, reject) => {
    var akismet = require('akismet').client({
      blog: this.localConfig.akismetSite,
      apiKey: this.localConfig.akismetApiKey
    })

    akismet.checkSpam({
      user_ip: this.ip,
      user_agent: this.useragent,
      comment_type: this.config.akismet.type,
      comment_author: fields[this.config.akismet.author],
      comment_author_email: fields[this.config.akismet.email],
      comment_author_url: fields[this.config.akismet.url],
      comment_content: fields[this.config.akismet.content]
    }, (err, isSpam) => {
      if (err) return reject(err)
      
      if (isSpam) return reject('IS_SPAM')

      return resolve(fields)
    })    
  })
}

Staticman.prototype._createDate = function (options) {
  var date = new Date()

  switch (options.format) {
    case 'timestamp':
      return date.getTime()

    case 'timestamp-seconds':
      return Math.floor(date.getTime() / 1000)

    case 'iso8601':
    default:
      return date.toISOString()
  }
}

Staticman.prototype._createFile = function (fields) {
  return new Promise((resolve, reject) => {
    switch (this.config.format.toLowerCase()) {
      case 'json':
        return resolve(JSON.stringify(fields))

      case 'yaml':
      case 'yml':
        try {
          var output = yaml.safeDump(fields)

          return resolve(output)
        } catch (err) {
          return reject(err)
        }

        break

      default:
        return reject('INVALID_FORMAT')
    }
  })
}

Staticman.prototype._getConfig = function (force) {
  if (this.config && !force) return Promise.resolve(this.config)

  if (!this.options.config) return Promise.reject('NO_CONFIG_PATH')

  return this.github.repos.getContent({
    user: this.options.username,
    repo: this.options.repository,
    path: this.options.config.file,
    ref: this.options.branch
  }).then((res) => {
    var content = new Buffer(res.content, 'base64').toString()

    try {
      var configFile = yaml.safeLoad(content, 'utf8')
      var config = objectPath.get(configFile, this.options.config.path)

      var validationErrors = this._validateConfig(config)

      if (validationErrors) {
        return Promise.reject(validationErrors)
      }

      if (config.branch !== this.options.branch) {
        return Promise.reject('BRANCH_MISMATCH')
      }

      return config
    } catch (err) {
      return Promise.reject(err)
    }
  })
}

Staticman.prototype._getExtensionForFormat = function (format) {
  switch (format.toLowerCase()) {
    case 'json':
      return 'json'

    case 'yaml':
    case 'yml':
      return 'yml'
  }
}

Staticman.prototype._resolvePlaceholders = function (subject, baseObject) {
  var matches = subject.match(/{(.*?)}/g)

  if (!matches) return subject

  matches.forEach((match) => {
    var escapedMatch = match.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
    var property = match.slice(1, -1)

    switch (property) {
      case '@timestamp':
        newText = new Date().getTime()

        break

      default:
        newText = objectPath.get(baseObject, property) || ''
    }

    subject = subject.replace(new RegExp(escapedMatch, 'g'), newText)
  })

  return subject
}

Staticman.prototype._sendPullRequest = function (fields, data, uid) {
  var branch = 'staticman_' + uid

  return this.github.repos.getBranch({
    user: this.options.username,
    repo: this.options.repository,
    branch: this.config.branch
  }).then((res) => {
    return this.github.gitdata.createReference({
      user: this.options.username,
      repo: this.options.repository,
      ref: 'refs/heads/' + branch,
      sha: res.commit.sha
    })
  }).then((res) => {
    return this._uploadFile(fields, data, uid, 'staticman_' + uid)
  }).then((res) => {
    return this.github.pullRequests.create({
      user: this.options.username,
      repo: this.options.repository,
      title: this.config.commitTitle,
      head: branch,
      base: this.config.branch,
      body: this.config.commitMessage
    })
  })
}

Staticman.prototype._validateConfig = function (config) {
  if (!config) {
    return {
      code: 'MISSING_CONFIG_BLOCK'
    }
  }

  var requiredFields = [
    'allowedFields',
    'branch',
    'format',
    'path'
  ]
  var defaultValues = {
    'commitTitle': 'Add Staticman entry',
    'commitMessage': 'YAY! Here\'s another entry.',
    'moderation': true,
    'transforms': {}
  }

  var missingFields = []

  // Checking for missing required fields
  requiredFields.forEach((requiredField) => {
    if (objectPath.get(config, requiredField) === undefined) {
      missingFields.push(requiredField)
    }
  })

  if (missingFields.length) {
    return {
      code: 'MISSING_CONFIG_FIELDS',
      data: missingFields
    }
  }

  // Add defaults
  Object.keys(defaultValues).forEach((defaultValueKey) => {
    if (objectPath.get(config, defaultValueKey) === undefined) {
      objectPath.set(config, defaultValueKey, defaultValues[defaultValueKey])
    }
  })

  // Discard everything except for the `staticman` object
  this.config = config

  return null
}

Staticman.prototype._validateFields = function (fields) {
  var errors = []
  var missingRequiredFields = []
  var invalidFields = []

  Object.keys(fields).forEach((field) => {
    // Check for any invalid fields
    if ((this.config.allowedFields.indexOf(field) === -1) && (fields[field] !== '')) {
      invalidFields.push(field)
    }

    // Trim fields
    if (typeof fields[field] === 'string') {
      fields[field] = fields[field].trim()
    }
  })

  // Check for missing required fields
  this.config.requiredFields.forEach((field) => {
    if ((fields[field] === undefined) || (fields[field] === '')) {
      missingRequiredFields.push(field)
    }
  })

  if (missingRequiredFields.length) {
    errors.push({
      code: 'MISSING_REQUIRED_FIELDS',
      data: missingRequiredFields
    })
  }

  if (invalidFields.length) {
    errors.push({
      code: 'INVALID_FIELDS',
      data: invalidFields
    })
  }

  if (errors.length) return errors

  return null
}

Staticman.prototype._uploadFile = function (fields, data, uid, branch) {
  branch = branch || this.config.branch

  var filename = this.config.filename ? this._resolvePlaceholders(this.config.filename, {
    fields: data,
    options: this.options
  }) : uid
  var path = this._resolvePlaceholders(this.config.path, {
    fields: data,
    options: this.options
  })

  var params = {
    user: this.options.username,
    repo: this.options.repository,
    path: path + '/' + filename + '.' + this._getExtensionForFormat(this.config.format),
    content: new Buffer(data).toString('base64'),
    message: this.config.commitTitle,
    branch: branch
  };

  if (this.config.commit && this.config.commit.name && this.config.commit.email) {
    params['committer'] = {
      name: fields[this.config.commit.name],
      email: fields[this.config.commit.email]
    }
  }

  return this.github.repos.createFile(params)
}

Staticman.prototype.initGithub = function () {
  this.github = new GitHubApi({
    debug: false,
    protocol: 'https',
    host: 'api.github.com',
    pathPrefix: '',
    headers: {
      'user-agent': 'Staticman agent'
    },
    timeout: 5000,
    Promise: Promise
  })

  this.github.authenticate({
    type: 'oauth',
    token: this.localConfig.githubToken
  })
}

Staticman.prototype.process = function (fields, options) {
  var uid = sha1(options.username + options.repo + new Date().getTime())

  return this._getConfig().then((res) => {
    return this._checkForSpam(fields)
  }).then((fields) => {
    // Validate fields
    var fieldErrors = this._validateFields(fields)

    if (fieldErrors) return Promise.reject(fieldErrors)

    // Add generated fields
    fields = this._applyGeneratedFields(fields)

    // Apply transforms
    return this._applyTransforms(fields)
  }).then((transformedFields) => {
    // Create file
    return this._createFile(transformedFields)
  }).then((file) => {
    if (this.config.moderation) {
      return this._sendPullRequest(fields, file, uid)
    }

    return this._uploadFile(fields, file, uid)
  }).then((result) => {
    return {
      fields: fields,
      redirect: options.redirect ? options.redirect : false
    }
  })
}

Staticman.prototype.setConfig = function (config) {
  this.options.config = config
}

Staticman.prototype.setIp = function (ip) {
  this.ip = ip
}

Staticman.prototype.setUserAgent = function (useragent) {
  this.useragent = useragent
}

module.exports = Staticman
