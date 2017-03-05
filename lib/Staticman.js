'use strict'

const config = require(__dirname + '/../config')
const GitHub = require('./GitHub')
const markdownTable = require('markdown-table')
const md5 = require('md5')
const Mailgun = require('mailgun-js')
const NodeRSA = require('node-rsa')
const objectPath = require('object-path')
const SiteConfig = require(__dirname + '/../siteConfig')
const slugify = require('slug')
const SubscriptionsManager = require('./SubscriptionsManager')
const uuid = require('node-uuid')
const yaml = require('js-yaml')

const Staticman = function (req) {
  this.parameters = req.params
  this.fields = Object.assign( {}, req.query.fields, req.body.fields)
  this.options = Object.assign( {}, req.query.options, req.body.options)

  // Initialise GitHub API
  this.github = new GitHub({
    username: this.parameters.username,
    repository: this.parameters.repository,
    branch: this.parameters.branch
  })

  // Generate unique id
  this.uid = uuid.v1()

  // Initialise RSA
  this.rsa = new NodeRSA()
  this.rsa.importKey(config.get('rsaPrivateKey'))
}

Staticman.prototype._applyInternalFields = function (data) {
  let internalFields = {
    _id: this.uid
  }

  // Inject parent, if present
  if (this.options.parent) {
    internalFields._parent = this.options.parent
  }

  return Object.assign(internalFields, data)
}

Staticman.prototype._applyGeneratedFields = function (data) {
  const generatedFields = this.siteConfig.get('generatedFields')

  if (!generatedFields) return data

  Object.keys(generatedFields).forEach(field => {
    const generatedField = generatedFields[field]

    if ((typeof generatedField === 'object') && (!(generatedField instanceof Array))) {
      const options = generatedField.options || {}

      switch (generatedField.type) {
        case 'date':
          data[field] = this._createDate(options)

          break

        case 'slugify':
          if (typeof this.options.field === 'string') {
            data[field] = slugify(data[this.options.field]).toLowerCase()
          }

          break
      }
    } else {
      data[field] = generatedField
    }
  })

  return data
}

Staticman.prototype._applyTransforms = function (fields) {
  const transforms = this.siteConfig.get('transforms')

  if (!transforms) return Promise.resolve(fields)

  // This doesn't serve any purpose for now, but we might want to have
  // asynchronous transforms in the future.
  let queue = []

  Object.keys(transforms).forEach(field => {
    if (!fields[field]) return

    if (transforms[field] === 'md5') {
      fields[field] = md5(fields[field])
    }
  })

  return Promise.all(queue).then((results) => {
    return fields
  })
}

Staticman.prototype._checkForSpam = function (fields) {
  if (!this.siteConfig.get('akismet.enabled')) return Promise.resolve(fields)

  return new Promise((resolve, reject) => {
    const akismet = require('akismet').client({
      blog: config.get('akismet.site'),
      apiKey: config.get('akismet.apiKey')
    })

    akismet.checkSpam({
      user_ip: this.ip,
      user_agent: this.userAgent,
      comment_type: this.siteConfig.get('akismet.type'),
      comment_author: fields[this.siteConfig.get('akismet.author')],
      comment_author_email: fields[this.siteConfig.get('akismet.authorEmail')],
      comment_author_url: fields[this.siteConfig.get('akismet.authorUrl')],
      comment_content: fields[this.siteConfig.get('akismet.content')]
    }, (err, isSpam) => {
      if (err) return reject(err)
      
      if (isSpam) return reject('IS_SPAM')

      return resolve(fields)
    })    
  })
}

Staticman.prototype._createDate = function (options) {
  const date = new Date()

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
    switch (this.siteConfig.get('format').toLowerCase()) {
      case 'json':
        return resolve(JSON.stringify(fields))

      case 'yaml':
      case 'yml':
        try {
          const output = yaml.safeDump(fields)

          return resolve(output)
        } catch (err) {
          return reject(err)
        }

        break

      case 'frontmatter':
        const transforms = this.siteConfig.get('transforms')

        const contentField = transforms && Object.keys(transforms).find(field => {
          return transforms[field] === 'frontmatterContent'
        })

        if (!contentField) {
          return reject('NO_FRONTMATTER_CONTENT_TRANSFORM')
        }

        const content = fields[contentField]

        delete fields[contentField]

        try {
          const output = `---\n${yaml.safeDump(fields)}---\n${content}\n`

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

Staticman.prototype._generatePRBody = function (fields) {
  let table = [
    ['Field', 'Content']
  ]

  Object.keys(fields).forEach(field => {
    table.push([field, fields[field]])
  })

  let message = this.siteConfig.get('pullRequestBody') + markdownTable(table)

  if (this.siteConfig.get('notifications.enabled')) {
    const notificationsPayload = {
      configPath: this.configPath,
      fields,
      options: this.options,
      parameters: this.parameters
    }

    message += `\n\n<!--staticman_notification:${JSON.stringify(notificationsPayload)}-->`
  }

  return message
}

Staticman.prototype.getSiteConfig = function (force) {
  if (this.siteConfig && !force) return Promise.resolve(this.siteConfig)

  if (!this.configPath) return Promise.reject('NO_CONFIG_PATH')

  return this.github.readFile(this.configPath.file).then(data => {
    const config = objectPath.get(data, this.configPath.path)
    let validationErrors

    try {
      validationErrors = this._validateConfig(config)
    } catch (e) {
      return Promise.reject(`Config validation failed:\n${e.stack}`)
    }

    if (validationErrors) {
      return Promise.reject(validationErrors)
    }

    if (config.branch !== this.parameters.branch) {
      return Promise.reject('BRANCH_MISMATCH')
    }

    return this.siteConfig
  })
}

Staticman.prototype._getNewFilePath = function (data) {
  const configFilename = this.siteConfig.get('filename')
  const filename = configFilename ? this._resolvePlaceholders(configFilename, {
    fields: data,
    options: this.options
  }) : this.uid

  let path = this._resolvePlaceholders(this.siteConfig.get('path'), {
    fields: data,
    options: this.options
  })

  // Remove trailing slash, if existing
  if (path.slice(-1) === '/') {
    path = path.slice(0, -1)
  }

  const extension = this._getExtensionForFormat(this.siteConfig.get('format'))

  return `${path}/${filename}.${extension}`
}

Staticman.prototype._getExtensionForFormat = function (format) {
  switch (format.toLowerCase()) {
    case 'json':
      return 'json'

    case 'yaml':
    case 'yml':
      return 'yml'

    case 'frontmatter':
      return 'md'
  }
}

Staticman.prototype._initialiseSubscriptions = function () {
  if (!this.siteConfig.get('notifications.enabled')) return null

  // Initialise Mailgun
  const mailgun = Mailgun({
    apiKey: this.siteConfig.get('notifications.apiKey') || config.get('email.apiKey'),
    domain: this.siteConfig.get('notifications.domain') || config.get('email.domain')
  })

  // Initialise SubscriptionsManager
  const subscriptions = new SubscriptionsManager(this.parameters, this.github, mailgun)

  return subscriptions
}

Staticman.prototype._resolvePlaceholders = function (subject, baseObject) {
  const matches = subject.match(/{(.*?)}/g)

  if (!matches) return subject

  matches.forEach((match) => {
    const escapedMatch = match.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
    const property = match.slice(1, -1)

    let newText

    switch (property) {
      case '@timestamp':
        newText = new Date().getTime()

        break

      case '@id':
        newText = this.uid

        break

      default:
        newText = objectPath.get(baseObject, property) || ''
    }

    subject = subject.replace(new RegExp(escapedMatch, 'g'), newText)
  })

  return subject
}

Staticman.prototype._validateConfig = function (config) {
  if (!config) {
    return {
      code: 'MISSING_CONFIG_BLOCK'
    }
  }

  const requiredFields = [
    'allowedFields',
    'branch',
    'format',
    'path'
  ]

  let missingFields = []

  // Checking for missing required fields
  requiredFields.forEach(requiredField => {
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

  // Check origin
  if (config.allowedOrigins && config.allowedOrigins.length) {
    if (this.options.origin) {
      const url = require('url').parse(this.options.origin)

      const validOrigin = config.allowedOrigins.some(origin => {
        return origin === url.hostname
      })

      if (!validOrigin) {
        return {
          code: 'INVALID_ORIGIN',
          data: null
        }
      }
    } else {
      return {
        code: 'MISSING_ORIGIN',
        data: null
      }
    }
  }

  this.siteConfig = SiteConfig(config, this.rsa)

  return null
}

Staticman.prototype._validateFields = function (fields) {
  let errors = []
  let missingRequiredFields = []
  let invalidFields = []

  Object.keys(fields).forEach(field => {
    // Check for any invalid fields
    if ((this.siteConfig.get('allowedFields').indexOf(field) === -1) && (fields[field] !== '')) {
      invalidFields.push(field)
    }

    // Trim fields
    if (typeof fields[field] === 'string') {
      fields[field] = fields[field].trim()
    }
  })

  // Check for missing required fields
  this.siteConfig.get('requiredFields').forEach(field => {
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

Staticman.prototype.decrypt = function (encrypted) {
  return this.rsa.decrypt(encrypted, 'utf8')
}

Staticman.prototype.processEntry = function () {
  return this.getSiteConfig().then(config => {
    return this._checkForSpam(this.fields)
  }).then(fields => {
    // Validate fields
    const fieldErrors = this._validateFields(fields)

    if (fieldErrors) return Promise.reject(fieldErrors)

    // Add generated fields
    fields = this._applyGeneratedFields(fields)

    // Apply transforms
    return this._applyTransforms(fields)
  }).then(transformedFields => {
    return this._applyInternalFields(transformedFields)
  }).then(extendedFields => {
    // Create file
    return this._createFile(extendedFields)
  }).then(data => {
    const fields = this.fields
    const options = this.options
    const filePath = this._getNewFilePath(this.fields)
    const subscriptions = this._initialiseSubscriptions()
    const commitMessage = this._resolvePlaceholders(this.siteConfig.get('commitMessage'), {
      fields,
      options
    })

    // Subscribe user, if applicable
    if (subscriptions && options.parent && options.subscribe && fields[options.subscribe]) {
      subscriptions.set(options.parent, fields[options.subscribe]).catch(err => {
        console.log(err.stack || err)
      })
    }

    if (this.siteConfig.get('moderation')) {
      const newBranch = 'staticman_' + this.uid

      return this.github.writeFileAndSendPR(filePath, data, newBranch, commitMessage, this._generatePRBody(fields))
    } else if (subscriptions && options.parent) {
      subscriptions.send(options.parent, fields, options)
    }

    return this.github.writeFile(filePath, data, this.parameters.branch, commitMessage)
  }).then(result => {
    return {
      fields: this.fields,
      redirect: this.options.redirect ? this.options.redirect : false
    }
  })
}

Staticman.prototype.processMerge = function (fields, options) {
  this.fields = Object.assign({}, fields)
  this.options = Object.assign({}, options)

  return this.getSiteConfig().then(config => {
    const subscriptions = this._initialiseSubscriptions()

    return subscriptions.send(this.options.parent, fields, options, this.siteConfig)
  })
}

Staticman.prototype.setConfigPath = function (configPath) {
  this.configPath = configPath
}

Staticman.prototype.setIp = function (ip) {
  this.ip = ip
}

Staticman.prototype.setUserAgent = function (userAgent) {
  this.userAgent = userAgent
}


module.exports = Staticman
