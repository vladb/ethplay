const fs = require('fs');
const Web3 = require('web3');
const fetch = require('isomorphic-fetch');
const _ = require('lodash');

const binanceUrl = 'https://api.binance.com/api/v1/ticker/allPrices';
const binanceDepthUrl = 'https://api.binance.com/api/v1/depth?symbol=EOSETH';
const _wsProviderUrl = 'ws://geth.cents.io:8546';

class EosLive {
    constructor(wsProviderUrl) {
        this.eosAddr = '0xd0a6e6c54dbc68db5db3a091b171a77407ff7ccf';
        this.perDay = 2000000000000000000000000;
        this.blockTimeMap = [];
        this.blockTimeMapReady = false;
        this.pending = {};
        this.marketPrice = 0;
        this.today = 0;
        this.crowdsalePrice = 0;

        const wsProvider = new Web3.providers.WebsocketProvider(wsProviderUrl);
        const eosAbi = JSON.parse(fs.readFileSync('./eosabi.json'));
        this.web3 = new Web3(wsProvider);
        this.eos = new this.web3.eth.Contract(eosAbi, this.eosAddr);
    
        this.web3.eth.subscribe('pendingTransactions', (err, res) => this.handlePendingTransaction(err, res));
        this.web3.eth.subscribe('newBlockHeaders', (err, res) => this.handleNewBlock(err, res));
        this.buildBlockTimeMap(this.getYesterdaysTimestamp());
        setInterval(() => this.checkMarketPrice(), 10000);
    }

    async handlePendingTransaction(err, res) {
        if(err) {
            return;
        }
    
        const trans = await this.web3.eth.getTransaction(res);
        if(trans && trans.to && trans.to.toLowerCase() === this.eosAddr.toLowerCase()) {
            this.pending[res] = parseInt(trans.value);
        }
    }

    async handleNewBlock(err, res) {
        if(err) {
            return;
        }
    
        const block = await this.web3.eth.getBlock(res.number);
        block.transactions.forEach(trans => {
            delete this.pending[trans];
        });
    
        this.checkCrowdsalePrice();
        this.checkReferencePrice();
    }

    getPendingAmount() {
        return _.sum(Object.values(this.pending));
    }

    async buildBlockTimeMap(timestamp) {
        let currentBlock = await this.web3.eth.getBlockNumber();
        let block;
    
        // use last few blocks to find avg block time (inefficient, but it doesn't really matter)
        if(!this.avgBlockTime) {
            let initialRunFor = 100;
            let lastTimestamp;
            const avgArr = [];
    
            while(initialRunFor) {
                await this.cacheBlockTimestamp(currentBlock);
    
                if(lastTimestamp) {
                    avgArr.push(lastTimestamp - this.blockTimeMap[currentBlock]);
                }
    
                lastTimestamp = this.blockTimeMap[currentBlock];
                currentBlock--;
                initialRunFor--;
            }
    
            this.avgBlockTime = avgArr.reduce((p, c) => c += p) / avgArr.length;
        }
    
        // try to find the block number we had yesterday at this time
        let lookBackBlockNumber = currentBlock - parseInt((23*3600) / this.avgBlockTime);
    
        while(1) {
            if(typeof this.blockTimeMap[lookBackBlockNumber] == 'undefined') {
                await this.cacheBlockTimestamp(lookBackBlockNumber);
            }
    
            // adjust (forward) if we've looked back too much (more than 10 minutes)
            if(this.blockTimeMap[lookBackBlockNumber] < timestamp - 600) {
                lookBackBlockNumber += parseInt((timestamp - this.blockTimeMap[lookBackBlockNumber]) / this.avgBlockTime);
                continue;
            }
    
            // found it (still approx but close)
            if(this.blockTimeMap[lookBackBlockNumber] < timestamp) {
                console.log(`found starting point. diff: ${timestamp - this.blockTimeMap[lookBackBlockNumber]}`);
                this.blockTimeMapReady = true;
                break;
            }
    
            // adjust (backwards) by 10 blocks
            lookBackBlockNumber -= 10;
        }
    
        // cache block timestamps for the next 60 mins
        for(let i = lookBackBlockNumber; i < currentBlock; i++) {
            await this.cacheBlockTimestamp(i);
    
            if(this.blockTimeMap[i] > timestamp + 60 * 60) {
                break;
            }
        }
    }

    async cacheBlockTimestamp(blockNumber) {
        if(typeof this.blockTimeMap[blockNumber] == 'undefined') {
            const block = await this.web3.eth.getBlock(blockNumber);
            this.blockTimeMap[blockNumber] = block.timestamp;
        }
    
        return this.blockTimeMap[blockNumber];
    }

    getYesterdaysTimestamp() {
        const now = new Date;
        const currentTimestamp = parseInt(
            Date.UTC(now.getUTCFullYear(),now.getUTCMonth(), now.getUTCDate(), 
            now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(),
            now.getUTCMilliseconds()) / 1000);
        return currentTimestamp - 23 * 3600;
    }

    findClosestBlock(timestamp) {
        const closest = _.reduce(this.blockTimeMap, (agg, val, key) => {
            if(Math.abs(timestamp - val) < Math.abs(timestamp - agg.blockTimestamp)) {
                agg.blockTimestamp = val;
                agg.blockNumber = key;
            }
    
            return agg;
        }, { blockNumber: null, blockTimestamp: 0 });
    
        // we found something, but validate the block time is within ±3 mins of
        // our timestamp. if it isn't, start looking for it and bail.
        const acceptableDiff = 5 * 60;
    
        if(!closest.blockNumber ||
            closest.blockTimestamp < timestamp - acceptableDiff || 
            closest.blockTimestamp > timestamp + acceptableDiff) {
            this.buildBlockTimeMap(timestamp);
            return false;
        }
    
        return closest.blockNumber;
    }

    async checkMarketPrice() {
        const currentMarketPrice = await fetch(binanceUrl)
            .then(res => res.json())
            .then(market => market.find((entry) => entry.symbol === 'EOSETH'))
            .then(entry => entry.price)
            .catch(e => console.log('error: could not fetch market price'));
    
        if(currentMarketPrice !== this.marketPrice) {
            this.marketPrice = currentMarketPrice;
            this.printData();
        }
    }

    async getCrowdsalePrice(blockNumber = 'latest') {
        const thisDay = await this.eos.methods.today().call({}, blockNumber);
        const dailyTotals = await this.eos.methods.dailyTotals(thisDay).call({}, blockNumber);
    
        // only overwrite the global with the latest block's "today"
        if(blockNumber == 'latest') {
            this.today = thisDay;
        }
    
        return {
            today: thisDay,
            dailyTotals
        }
    }

    async checkCrowdsalePrice() {
        try {
            const { today, dailyTotals } = await this.getCrowdsalePrice();
            const currentCrowdsalePrice = dailyTotals / this.perDay;
    
            if(currentCrowdsalePrice !== this.crowdsalePrice /* && crowdsalePrice < currentCrowdsalePrice */) {
                this.crowdsalePrice = currentCrowdsalePrice;
                this.printData();
            }    
        } catch(e) {
            console.log(e);
            console.log('error: could not fetch crowdsale price');
        }
    }

    async checkReferencePrice() {
        const yesterday = this.getYesterdaysTimestamp();
        const closestBlock = this.findClosestBlock(yesterday);
    
        if(!closestBlock || !this.crowdsalePrice) {
            return false;
        }
    
        const yesterdaysPrice = await this.getCrowdsalePrice(closestBlock);
        const currEthContrib = this.crowdsalePrice * this.perDay / 1000000000000000000;
        const ydayEthContrib = yesterdaysPrice.dailyTotals / 1000000000000000000;
    
        if(this.blockTimeMapReady && (!this.prevEthContrib || this.prevEthContrib < ydayEthContrib)) {
            this.prevEthContrib = ydayEthContrib;
            const diff = (currEthContrib * 100 / ydayEthContrib).toFixed(2);
            console.log(`curr: ${currEthContrib.toFixed(2)} eth, prev (${yesterdaysPrice.today}): ${ydayEthContrib.toFixed(2)} eth, diff% ${diff}`);
        }
    }

    padDate(d) {
        return ('0' + d).slice(-2);
    }

    getTimestamp() {
        const time = new Date();
        return `${this.padDate(time.getHours())}:${this.padDate(time.getMinutes())}:${this.padDate(time.getSeconds())}`;
    }

    printData() {
        const potentialPrice = this.crowdsalePrice + this.getPendingAmount() / this.perDay;
    
        let diff = 0, pdiff = 0;
        if(this.marketPrice && this.crowdsalePrice) {
            diff = this.marketPrice * 100 / this.crowdsalePrice - 100;
            pdiff = this.marketPrice * 100 / potentialPrice - 100;
        }
    
        console.log(`${this.getTimestamp()} crowdsale #${this.today || '?'}: ${(this.crowdsalePrice || 0).toFixed(8) || '?'} [~ ${(potentialPrice || 0).toFixed(8)}], market: ${this.marketPrice || '?'}, profit%: ${diff.toFixed(2) || '?'} [~ ${pdiff.toFixed(2) || '?'}]`);
    }
}

new EosLive(_wsProviderUrl);
