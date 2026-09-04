# Build context: packages/dotnet (so global.json and Directory.Build.props are one level up
# from this project). No BTCPay submodule is needed for this project.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY global.json Directory.Build.props ./
COPY OpenReceive.TestkitNwc/OpenReceive.TestkitNwc.csproj OpenReceive.TestkitNwc/
RUN dotnet restore OpenReceive.TestkitNwc/OpenReceive.TestkitNwc.csproj
COPY OpenReceive.TestkitNwc/ OpenReceive.TestkitNwc/
RUN dotnet publish OpenReceive.TestkitNwc/OpenReceive.TestkitNwc.csproj -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .
EXPOSE 7790
ENTRYPOINT ["dotnet", "OpenReceive.TestkitNwc.dll"]
