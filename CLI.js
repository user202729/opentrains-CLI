#!/bin/node
"use strict"

const {program}=require("commander")
const rl=require("readline").createInterface({input: process.stdin, output: process.stdout})
rl.pause()
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

function readline(query){ return new Promise(
	//rl.resume()
	(resolve, _reject)=>rl.question(query, function(answer){
		rl.pause()
		resolve(answer)
	})
)}

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

	const result=await f()
	const $=cheerio.load(result.data)
	if($("title").text()!=="Invalid session")
		return result

	await login()
	return await f()
}

function parseSubmissions(data){ // data: HTML string
	// might throw an error
	// see printSubmissions for return format
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
	return rows.slice(1).map(
		row=>$(row).find("td").toArray().map(cell=>$(cell).text()).slice(0, -2)
	)
}

function printSubmissions(data){ // data: HTML string
	const result=parseSubmissions(data)
	console.table(result.reverse().map(
		([RunId, Time, Size, Problem, Language, Result])=>({RunId, Time, Size, Problem, Language, Result})
	))
}

async function listAllCommand(options){
	await login(options.parent)
	const result=await checkSession(async ()=>await axios.get(`${options.parent.url}?SID=${SidOf[contestId]}&all_runs=1&action=140`))
	// run id, time, size, problem, language, result, failed test, view source, view report
	printSubmissions(result.data)
}

async function submit(problemIndex, languageIndex, fileName, options){
	// options: (same as function login)
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


	if(problemIndex!==parseInt(problemIndex).toString())
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
	return await checkSession(async ()=>await axios.post(`${options.url}`, form.getBuffer(), {headers: form.getHeaders()}))
	// Note: it appears that the server does not support HTTP chunked encoding.
	// form.getBuffer() and readFileSync will do it (at least for this version)
}

async function submitCommand(problemIndex, languageIndex, fileName, options){
	const result=await submit(problemIndex, languageIndex, fileName, options.parent)
	printSubmissions(result.data)
}

program.version("0.0.0")
.option("-U, --url <url>", "url",
	"http://opentrains.mipt.ru/~ejudge/team.cgi"
	//"http://localhost/"
)
.option("-c, --contestid <contestid>", "contest id (if not specified, the last contest ID will be used)")
.option("-u, --username <username>", "username (login)", username)
.option("-p, --password <password>", "password (specify empty password for a prompt. "+
	"If not specified, the last password will be used)", password)

program.command("list_all")
.alias("ls")
.alias("listall")
.alias("list-all")
.description("list all submissions")
.action(listAllCommand)

program.command("submit <problemindex> <languageindex> <filename>")
.alias("sub")
.description("submit")
.action(submitCommand)

program.parse(process.argv)
