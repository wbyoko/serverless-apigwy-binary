const BbPromise = require('bluebird')

class ApiGwyBinaryPlugin {
  constructor (serverless, options) {
    this.serverless = serverless
    this.options = options
    this.provider = this.serverless.getProvider('aws')

    this.hooks = {
      'after:aws:deploy:deploy:updateStack': this.configureApiGwy.bind(this)
    }
  }

  configureApiGwy () {
    return BbPromise.bind(this)
      .then(this.getFunctionsForContentHandling)
      .then(this.setContentHandling)
  }

  setContentHandling (funcs) {
    if (!Object.keys(funcs).length) {
      return
    }
    const apiName = this.provider.naming.getApiGatewayName()

    const apigateway = new this.provider.sdk.APIGateway({
      region: this.options.region
    })

    const integrationResponseParams = {
      statusCode: '200'
    }

    return apigateway
    .getRestApis()
    .promise()
    .then((apis) => {
      integrationResponseParams.restApiId = apis.items.find(api => api.name === apiName).id

      return apigateway
        .getResources({ restApiId: integrationResponseParams.restApiId })
        .promise()
    })
    .then((resources) => {
      const integrationPromises = []

      Object.keys(funcs).forEach((fKey) => {
        funcs[fKey].events.forEach(async (e) => {
          if (e.http && e.http.contentHandling) {
            integrationResponseParams.httpMethod = e.http.method.toUpperCase()
            integrationResponseParams.resourceId = resources.items.find(
              r => r.path === `/${e.http.path}`).id
            
            // first, get the original integration response
            let integrationResponse = await apigateway.getIntegrationResponse(integrationResponseParams).promise();
            // add contentHandling:
            integrationResponse.contentHandling = e.http.contentHandling;
            // copy params required for putting response back:
            Object.assign(integrationResponse,integrationResponseParams);
            // write back the modified integration response to AWS:
            // => replace nulls with empty strings
            Object.keys(integrationResponse.responseTemplates).forEach((contentType)=>{
                if (integrationResponse.responseTemplates[contentType] == null) {
                    integrationResponse.responseTemplates[contentType] = "";
                }
            });
            // write back the modified integration response to AWS:
  
            let integrationResponse = await apigateway.getIntegrationResponse(integrationResponseParams).promise();
            integrationPromises
            .push(apigateway.putIntegrationResponse(integrationResponse).promise())
          }
        })
      })

      this.serverless.cli.log('Setting up content handling in AWS API Gateway (takes ~1 min)...')
      return BbPromise.all(integrationPromises)
    })
    // AWS Limit createDeployment: 3 requests per minute per account
    // 'Too Many Requests', error may occur as serverless calls this endpoint also.
    // Wait 1 minute to get reliable deployment.
    // http://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html
    .then(() => new BbPromise(resolve => setTimeout(() => resolve(), 60000)))
    .then(() => {
      this.serverless.cli.log('Deploying content handling updates to AWS API Gateway...')
      return apigateway.createDeployment({
        stageName: this.options.stage,
        restApiId: integrationResponseParams.restApiId
      }).promise()
    })
    .then((result) => {
      if (result.id) {
        this.serverless.cli.log('AWS API Gateway Deployed')
      }
    })
    .catch(err => this.serverless.cli.log(err.message))
  }

  getFunctionsForContentHandling () {
    const funcs = this.serverless.service.functions
    const validFuncs = {}

    Object.keys(funcs).forEach((fKey) => {
      funcs[fKey].events.forEach((e) => {
        if (e.http && e.http.contentHandling) {
          validFuncs[fKey] = funcs[fKey]
        }
      })
    })
    return validFuncs
  }
}

module.exports = ApiGwyBinaryPlugin
