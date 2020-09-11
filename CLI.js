#!/bin/node
"use strict"

const {program}=require("commander")
const readline_=require("readline")
const fs=require("fs")
const qs=require("qs")
const axios=require("axios")
const FormData=require("form-data")
const path=require("path")
const cheerio=require("cheerio")

process.on('unhandledRejection', err => { // for convenience in debugging
  console.error(err)
  process.exit(1)
});

// load stored username/password
const storePath="/tmp/.opentrains-CLI-store"
let username, password, SidOf
let contestId // last used
try{
	({username, password, SidOf, contestId}=JSON.parse(fs.readFileSync(storePath)))
}catch(e){
	if(e.code!=="ENOENT")
		throw e
}
if(!SidOf) SidOf={}

function sleep(time){ return new Promise(
	(resolve, _reject)=>setTimeout(resolve, time)) }
function readline(query){ return new Promise(
	// might not work properly if multiple functions try to call this function at the same time.
	function(resolve, _reject){
		const rl=readline_.createInterface({input: process.stdin, output: process.stdout})
		rl.question(query, function(answer){
			rl.close()
			resolve(answer)
		})
	})
}

async function login(options){
	// options: {username, contestid, password, url}
	if(options.username) username=options.username
	if(options.contestid) contestId=options.contestid
	if(options.password) password=options.password

	if(!username) throw Error("username is empty!")
	if(!contestId) throw Error("contestId is empty!")
	while(!password){
		password=await readline("Enter password: ")
	}

	if(!SidOf[contestId]){
		saveFile()
		const result=await axios.post(options.url, qs.stringify({
			contest_id: contestId, role: 0, login: username, password,
			locale_id: 0, // English
			submit: "Log in" // also posted by form, but likely accidentally
		}))
		SidOf[contestId]=result.request.path.match(/\?SID=(.+?)&/)[1]
	}
	saveFile()
}

function saveFile(){
	fs.writeFileSync(storePath, JSON.stringify({username, password, SidOf, contestId}))
}

async function checkSession(f){
	// f: () -> axios response object
	// might call f twice if the session has expired
	// also returns the axios response object

	const result=await f()
	const $=cheerio.load(result.data)
	if($("title").text()!=="Invalid session")
		return result

	await login()
	return await f()
}

function parseTable(data){ // data: HTML string
	// checks for "Operation completed with errors" title
	// use `table.b1` selector
	// returns the text in each table cell

	const $=cheerio.load(data)
	if($("title").text()==="Operation completed with errors"){
		fs.writeFileSync("/tmp/error_log.html", data)
		throw Error($("pre").text().trim())
	}
	const rows=$("table.b1 tr").toArray()
	if(rows.length===0){
		fs.writeFileSync("/tmp/error_log.html", data)
		throw Error("Invalid HTML")
	}
	return rows.map(
		row=>$(row).find("td").toArray().map(cell=>$(cell).text())
	)
}

function parseSubmissions(data){ // data: HTML string
	// might throw an error
	// see printSubmissions for return format
	return parseTable(data).slice(1).map(row=>row.slice(0, -2))
}

function printSubmissions(data){ // data: result of parseSubmissions
	console.table(data.map(
		([RunId, Time, Size, Problem, Language, Result, FailedTest])=>({RunId, Time, Size, Problem, Language, Result, FailedTest})
	))
}

async function getProblems(options){
	// options: (same as function login)
	// return type: list of [short name, long name, several other stuff]
	await login(options)
	const result=await checkSession(async ()=>await axios.get(`${options.url}?SID=${SidOf[contestId]}&action=137`))
	return parseTable(result.data).slice(1)
}

async function problemsCommand(options){
	const result=await getProblems(options.parent)
	console.table(result)
}

async function getAllSubmissions(options){ // download and parse submissions.
	// options: (same as function login)
	// return type: same as parseSubmissions
	await login(options)
	const result=await checkSession(async ()=>await axios.get(`${options.url}?SID=${SidOf[contestId]}&all_runs=1&action=140`))
	return parseSubmissions(result.data)
}

function noneWaiting(data){
	// data: parseSubmissions output format
	// return: bool
	return data.find(row=>row[5].includes("..."))===undefined
}

const watchDelay=2000
async function watchSubmissions(options){ // returns when there's no pending submission left
	// first print is immediate.
	// options: (same as function login)
	while(true){
		const data=await getAllSubmissions(options)
		printSubmissions(data)
		if(noneWaiting(data))
			break
		await sleep(watchDelay)
	}
}

async function listAllCommand(options){
	await watchSubmissions(options.parent)
}

async function submit(problemIndex, languageIndex, fileName, options){
	// options: (same as function login)
	// returns page content (contains submissions info -- axios automatically follows redirect)

	/* languageIndex (at the time of writing)
	2	gcc - GNU C 6.4.0
	3	g++ - GNU C++ 8.2 (c++17)
	5	javac - Java JDK 1.8
	10	javac-32 - Java JDK (32 bit) 1.8
	13	python - Python 2.7.5
	23	python3 - Python3 3.6.1
	63	pypy - Python (PyPy) 2.7.13
	64	pypy3 - Python3 (PyPy) 3.5.3
	66	kotlin - Kotlin (kotlinc-jvm 1.1.3-2)
	91	dmd - Unidentified DMD
	*/
	await login(options)

	if(!["2", "3", "5", "10", "13", "23", "63", "64", "66", "91"].includes(languageIndex))
		throw Error("Invalid languageIndex: "+languageIndex)


	if(isNaN(parseInt(problemIndex)))
		throw Error("Invalid problemIndex: "+problemIndex)

	const form=new FormData() // multipart/form-data
	form.append("SID", SidOf[contestId])
	form.append("prob_id", problemIndex) // 11 for example
	form.append("lang_id", languageIndex)
	form.append("file", 
		//fs.createReadStream(fileName),
		fs.readFileSync(fileName),
		path.basename(fileName))
	form.append("action_40", "Send!") // perhaps unintentional?...
	const result=await checkSession(async ()=>await axios.post(`${options.url}`, form.getBuffer(), {headers: form.getHeaders()}))
	// Note: it appears that the server does not support HTTP chunked encoding.
	// form.getBuffer() and readFileSync will do it (at least for this version)
	return result.data
}

async function submitCommand(languageIndex, fileName, problemIndex, options){
	if((problemIndex!==undefined)+(options.shortname!==undefined)+(options.longname!==undefined)!==1)
		throw Error("Exactly one of problemIndex, shortname, or longname must be specified")

	if(options.longname!==undefined){
		const problemName=options.longname.trim()
		problemIndex=(await getProblems(options.parent)).findIndex(function(row){return row[1].trim()===problemName})
		if(problemIndex===-1)
			throw Error(`Cannot find long problem name: ${problemName}`)
		problemIndex+=1
	}
	else if(options.shortname!==undefined){
		const problemName=options.shortname.trim()
		problemIndex=(await getProblems(options.parent)).findIndex(function(row){return row[0].trim()===problemName})
		if(problemIndex===-1)
			throw Error(`Cannot find short problem name: ${problemName}`)
		problemIndex+=1
	}
	else{
		const problemIndex1=parseInt(problemIndex)
		if(isNaN(problemIndex1))
			throw Error(`Invalid problem index: ${problemIndex}`)
		problemIndex=problemIndex1
	}

	const data=await submit(problemIndex, languageIndex, fileName, options.parent)
	printSubmissions(parseSubmissions(data))
	await sleep(watchDelay) // it's almost certain that the program is not yet compiled
	await watchSubmissions(options.parent)
}

program.version("0.2.0")
.option("-U, --url <url>", "url",
	"http://opentrains.mipt.ru/~ejudge/team.cgi"
	//"http://localhost/"
)
.option("-c, --contestid <contestid>", "contest id (if not specified, the last contest ID will be used)")
.option("-u, --username <username>", "username (login)", username)
.option("-p, --password <password>", "password (specify empty password for a prompt. "+
	"If not specified, the last password will be used)", password)

program.command("problems")
.description("list all problems")
.action(problemsCommand)

program.command("list_all")
.alias("ls")
.alias("listall")
.alias("list-all")
.description("list all submissions")
.action(listAllCommand)

program.command("submit <languageindex> <filename> [problemindex]")
.alias("sub")
.description("submit")
.option("-s, --shortname <name>", "problem short name")
.option("-l, --longname <name>", "problem long name")
.action(submitCommand)

program.parse(process.argv)
