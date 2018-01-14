const fs = require('fs');
const Web3 = require('web3');
const fetch = require('isomorphic-fetch');
const _ = require('lodash');

const binanceUrl = 'https://api.binance.com/api/v1/ticker/allPrices';
const binanceRefresh = 10000;
const crowdsaleRefresh = 2000;

// const httpProviderUrl = 'https://mainnet.infura.io/';
const httpProviderUrl = 'https://geth.cents.io/vitalik-te-iubeste';
const httpProvider = new Web3.providers.HttpProvider(httpProviderUrl);
const web3 = new Web3(httpProvider);

const eosAbi = JSON.parse(fs.readFileSync('./eosabi.json'));
const eosAddr = "0xd0a6e6c54dbc68db5db3a091b171a77407ff7ccf";
const eos = new web3.eth.Contract(eosAbi, eosAddr);

let marketPrice, today, crowdsalePrice = 0;
//const perDay = await eos.methods.createPerDay().call();
const perDay = 2000000000000000000000000;

const blockTimeMap = [];
let blockTimeMapReady = false;
let avgBlockTime;

async function buildBlockTimeMap(timestamp) {
    let currentBlock = await web3.eth.getBlockNumber();
    let block;

    // use last few blocks to find avg block time (inefficient, but it doesn't really matter)
    if(!avgBlockTime) {
        let initialRunFor = 100;
        let lastTimestamp;
        const avgArr = [];

        while(initialRunFor) {
            await cacheBlockTimestamp(currentBlock);

            if(lastTimestamp) {
                avgArr.push(lastTimestamp - blockTimeMap[currentBlock]);
            }

            lastTimestamp = blockTimeMap[currentBlock];
            currentBlock--;
            initialRunFor--;
        }

        avgBlockTime = avgArr.reduce((p, c) => c += p) / avgArr.length;
    }

    // try to find the block number we had yesterday at this time
    let lookBackBlockNumber = currentBlock - parseInt((23*3600) / avgBlockTime);

    while(1) {
        if(typeof blockTimeMap[lookBackBlockNumber] == 'undefined') {
            await cacheBlockTimestamp(lookBackBlockNumber);
        }

        // adjust (forward) if we've looked back too much (more than 10 minutes)
        if(blockTimeMap[lookBackBlockNumber] < timestamp - 600) {
            lookBackBlockNumber += parseInt((timestamp - blockTimeMap[lookBackBlockNumber]) / avgBlockTime);
            continue;
        }

        // found it (still approx but close)
        if(blockTimeMap[lookBackBlockNumber] < timestamp) {
            console.log(`found starting point. diff: ${timestamp - blockTimeMap[lookBackBlockNumber]}`);
            blockTimeMapReady = true;
            break;
        }

        // adjust (backwards) by 10 blocks
        lookBackBlockNumber -= 10;
    }

    // cache block timestamps for the next 60 mins
    for(let i = lookBackBlockNumber; i < currentBlock; i++) {
        await cacheBlockTimestamp(i);

        if(blockTimeMap[i] > timestamp + 60 * 60) {
            break;
        }
    }
}

async function cacheBlockTimestamp(blockNumber) {
    if(typeof blockTimeMap[blockNumber] == 'undefined') {
        const block = await web3.eth.getBlock(blockNumber);
        blockTimeMap[blockNumber] = block.timestamp;
    }

    return blockTimeMap[blockNumber];
}

function getYesterdaysTimestamp() {
    const now = new Date;
    const currentTimestamp = parseInt(
        Date.UTC(now.getUTCFullYear(),now.getUTCMonth(), now.getUTCDate(), 
        now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(),
        now.getUTCMilliseconds()) / 1000);
    return currentTimestamp - 23 * 3600;
}

function findClosestBlock(timestamp) {
    const closest = _.reduce(blockTimeMap, (agg, val, key) => {
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
        buildBlockTimeMap(timestamp);
        return false;
    }

    return closest.blockNumber;
}

async function checkMarketPrice() {
    const currentMarketPrice = await fetch(binanceUrl)
        .then(res => res.json())
        .then(market => market.find((entry) => entry.symbol === 'EOSETH'))
        .then(entry => entry.price)
        .catch(e => console.log('error: could not fetch market price'));

    if(currentMarketPrice !== marketPrice) {
        marketPrice = currentMarketPrice;
        printData();
    }
}

async function getCrowdsalePrice(blockNumber = 'latest') {
    const thisDay = await eos.methods.today().call({}, blockNumber);
    const dailyTotals = await eos.methods.dailyTotals(thisDay).call({}, blockNumber);

    // only overwrite the global with the latest block's "today"
    if(blockNumber == 'latest') {
        today = thisDay;
    }

    return {
        today: thisDay,
        dailyTotals
    }
}

async function checkCrowdsalePrice() {
    try {
        const { today, dailyTotals } = await getCrowdsalePrice();
        const currentCrowdsalePrice = dailyTotals / perDay;

        if(currentCrowdsalePrice !== crowdsalePrice && crowdsalePrice < currentCrowdsalePrice) {
            crowdsalePrice = currentCrowdsalePrice;
            printData();
        }    
    } catch(e) {
        console.log('error: could not fetch crowdsale price');
    }
}

let prevEthContrib;
async function checkReferencePrice() {
    const yesterday = getYesterdaysTimestamp();
    const closestBlock = findClosestBlock(yesterday);

    if(!closestBlock || !crowdsalePrice) {
        return false;
    }

    const yesterdaysPrice = await getCrowdsalePrice(closestBlock);
    const currEthContrib = crowdsalePrice * perDay / 1000000000000000000;
    const ydayEthContrib = yesterdaysPrice.dailyTotals / 1000000000000000000;

    if(blockTimeMapReady && (!prevEthContrib || prevEthContrib < ydayEthContrib)) {
        prevEthContrib = ydayEthContrib;
        const diff = (currEthContrib * 100 / ydayEthContrib).toFixed(2);
        console.log(`curr: ${currEthContrib.toFixed(2)} eth, prev (${yesterdaysPrice.today}): ${ydayEthContrib.toFixed(2)} eth, diff% ${diff}`);
    }
}

const padDate = (d) => ('0' + d).slice(-2);

function getTimestamp() {
    const time = new Date();
    return `${padDate(time.getHours())}:${padDate(time.getMinutes())}:${padDate(time.getSeconds())}`;
}

function printData() {
    let diff = 0;
    if(marketPrice && crowdsalePrice) {
        diff = marketPrice * 100 / crowdsalePrice - 100;
    }
    console.log(`${getTimestamp()} crowdsale #${today || '?'}: ${crowdsalePrice.toFixed(8) || '?'}, market: ${marketPrice || '?'}, profit%: ${diff.toFixed(2) || '?'}`);
}

buildBlockTimeMap(getYesterdaysTimestamp());

setInterval(checkMarketPrice, binanceRefresh);
setInterval(checkCrowdsalePrice, crowdsaleRefresh);
setInterval(checkReferencePrice, crowdsaleRefresh);
