const fs = require('fs');
const Web3 = require('web3');
const fetch = require('isomorphic-fetch');
const _ = require('lodash');
const colors = require('colors/safe');

const binanceUrl = 'https://api.binance.com/api/v1/ticker/allPrices';
const binanceDepthUrl = 'https://api.binance.com/api/v1/depth?symbol=EOSETH&limit=500';
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
            this.pending[res.toLowerCase()] = parseInt(trans.value);
        }
    }

    async handleNewBlock(err, res) {
        if(err) {
            return;
        }
    
        const block = await this.web3.eth.getBlock(res.number, true);
        block.transactions.forEach(trans => {
            delete this.pending[trans.hash.toLowerCase()];
        });
    
        const gasStats = this.getGasStats(block.transactions);
        console.log(colors.gray(`         block #${block.number} gas stats (gwei): ${gasStats.min} / ${gasStats.median} / ${gasStats.max}`));

        this.checkCrowdsalePrice();
        this.checkReferencePrice();
    }

    getGasStats(transactions) {
        const gasPrices = [];
        transactions.forEach(t => gasPrices.push(parseInt(t.gasPrice) / 1000000000));
        gasPrices.sort((a, b) => a - b);

        const middle = Math.floor(gasPrices.length / 2);
        let median;

        if(gasPrices.length % 2) {
            median = gasPrices[middle];
        } else {
            median = (gasPrices[middle-1] + gasPrices[middle]) / 2.0;
        }

        return {
            min: _.head(gasPrices).toFixed(2),
            median: median.toFixed(2), 
            max: _.last(gasPrices).toFixed(2)
        }
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

        this.currentMarketDepth = await this.checkDepthForPrice(parseFloat(this.crowdsalePrice));

        this.previousMarketPrice = this.marketPrice || currentMarketPrice;
        if(currentMarketPrice !== this.marketPrice) {
            this.marketPrice = currentMarketPrice;
            this.printData();
        }
    }

    async checkDepthForPrice(price) {
        return await fetch(binanceDepthUrl)
            .then(res => res.json())
            .then(res => res.bids.reduce((a, v) => {
                v[0] = parseFloat(v[0]);
                v[1] = parseFloat(v[1]);

                if(v[0] >= price) {
                    a += v[0] * v[1];
                }

                return a;
            }, 0))
            .then(vol => vol.toFixed(0));
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

            this.previousCrowdsalePrice = this.crowdsalePrice || currentCrowdsalePrice;
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
            console.log(colors.gray(`         curr: ${currEthContrib.toFixed(2)} eth, prev (${yesterdaysPrice.today}): ${ydayEthContrib.toFixed(2)} eth, diff% ${diff}`));
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
        const pendingAmount = this.getPendingAmount();
        const potentialPrice = this.crowdsalePrice + this.getPendingAmount() / this.perDay;
    
        let diff = 0, pdiff = 0;
        if(this.marketPrice && this.crowdsalePrice) {
            diff = this.marketPrice * 100 / this.crowdsalePrice - 100;
            pdiff = this.marketPrice * 100 / potentialPrice - 100;
        }

        let strPotentialPrice = '', strPotentialProfit = '';
        if(pendingAmount) {
            strPotentialPrice = ` [~ ${(potentialPrice || 0).toFixed(8)}]`;
            strPotentialProfit = ` [~ ${pdiff.toFixed(2) || '?'}]`;
        }

        let strCrowdsalePrice = (this.crowdsalePrice || 0).toFixed(8) || '?';
        let strMarketPrice = this.marketPrice || '?';
        let strProfit = diff.toFixed(2) || '?';

        if(this.previousCrowdsalePrice) {
            if(this.previousCrowdsalePrice < this.crowdsalePrice) {
                strCrowdsalePrice = colors.red(strCrowdsalePrice);
            } else if(this.previousCrowdsalePrice > this.crowdsalePrice) {
                strCrowdsalePrice = colors.green(strCrowdsalePrice);
            }
        }

        if(this.previousMarketPrice) {
            if(this.previousMarketPrice < this.marketPrice) { 
                strMarketPrice = colors.green(strMarketPrice);
            } else if(this.previousMarketPrice > this.marketPrice) {
                strMarketPrice = colors.red(strMarketPrice);
            }
        }

        if(this.previousCrowdsalePrice || this.previousMarketPrice) {
            let prevDiff = this.previousMarketPrice * 100 /  this.previousCrowdsalePrice - 100;
            if(prevDiff > diff) {
                strProfit = colors.red(strProfit);
            } else if(prevDiff < diff) {
                strProfit = colors.green(strProfit);
            }
        }
    
        console.log('%s crowdsale #%d: %s%s, vol: %s eth, market: %s, profit%: %s%s',
            this.getTimestamp(),
            this.today || '?',
            strCrowdsalePrice,
            strPotentialPrice,
            this.currentMarketDepth || '?',
            strMarketPrice,
            strProfit,
            strPotentialProfit
        );
    }
}

new EosLive(_wsProviderUrl);
