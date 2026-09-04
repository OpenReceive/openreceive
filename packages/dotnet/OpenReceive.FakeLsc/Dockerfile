# Build context: packages/dotnet
#   docker build -f OpenReceive.FakeLsc/Dockerfile -t openreceive-fake-lsc .
#   docker run -p 7788:7788 openreceive-fake-lsc --port 7788 --cert /certs/fake-lsc.pfx --cert-password x \
#     --payer "type=lnd-rest;server=http://customer_lnd:8080/;allowinsecure=true" --network regtest
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY global.json Directory.Build.props ./
COPY OpenReceive.FakeLsc/OpenReceive.FakeLsc.csproj OpenReceive.FakeLsc/
RUN dotnet restore OpenReceive.FakeLsc/OpenReceive.FakeLsc.csproj
COPY OpenReceive.FakeLsc/*.cs OpenReceive.FakeLsc/
RUN dotnet publish OpenReceive.FakeLsc/OpenReceive.FakeLsc.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .
EXPOSE 7788
ENTRYPOINT ["dotnet", "OpenReceive.FakeLsc.dll"]
